/**
 * Coldtill PaymentProvider for DashCommerce.
 *
 * Checkout: create a Coldtill payment for the cart total and send the buyer to its hosted checkout.
 * Webhook: entry.ts verifies Coldtill's timestamped signature and hands the event to DashCommerce's own webhook
 * route, which calls verifyWebhook, parseWebhookEvent and getPaymentStatus below before it creates the order.
 */

import type {
	InitCheckoutInput,
	InitCheckoutResult,
	NormalizedPaymentEvent,
	PaymentProvider,
	PaymentProviderCredentials,
	PaymentProviderRuntimeContext,
	PaymentStatusResult,
	RefundResult,
	VerifyWebhookInput,
	VerifyWebhookResult,
} from "@dashcommerce/core/payment-provider";

export const COLDTILL_PROVIDER_ID = "coldtill";

/** Invoice IDs look like DC-<orderDraftId>, the way the WooCommerce plugin uses WC-<order number>. */
const INVOICE_PREFIX = "DC-";

/** Deliveries signed more than five minutes ago are refused, matching Coldtill's other integrations. */
export const SIGNATURE_TOLERANCE_SECONDS = 300;

type PaymentState = "OPEN" | "PARTIALLY_FILLED" | "FILLED" | "OVER_FILLED" | "CANCELLED" | "REPLACED";

interface ColdtillPayment {
	invoiceID: string;
	referenceID: string;
	amountInUSD: string;
	paymentState: PaymentState;
}

interface PaymentEvent {
	event?: string;
	customer_id?: string;
	invoice_id?: string;
	reference_id?: string;
	status?: PaymentState;
	amount?: string;
}

class ColdtillApiError extends Error {
	constructor(
		public status: number,
		message: string,
	) {
		super(message);
		this.name = "ColdtillApiError";
	}
}

/** USD cents to a "12.34" string without going through floating point. */
export function centsToUsd(cents: number): string {
	if (!Number.isSafeInteger(cents) || cents < 0) throw new Error(`invalid amount: ${cents}`);
	return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;
}

/** "12.34" (any number of decimals) to cents, rounded half up. */
export function usdToCents(usd: string): number {
	const m = /^(\d+)(?:\.(\d+))?$/.exec(usd.trim());
	if (!m) throw new Error(`invalid USD amount: ${usd}`);
	const frac = (m[2] ?? "").padEnd(3, "0");
	return Number(m[1]) * 100 + Number(frac.slice(0, 2)) + (Number(frac[2]) >= 5 ? 1 : 0);
}

const enc = new TextEncoder();

function toHex(buf: ArrayBuffer): string {
	return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function fromHex(hex: string): Uint8Array<ArrayBuffer> | null {
	if (!/^(?:[0-9a-f]{2})+$/.test(hex)) return null;
	const out = new Uint8Array(hex.length / 2);
	for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
	return out;
}

/**
 * Coldtill's X-Coldtill-Signature-V2 is HMAC-SHA256 over "<timestamp>.<raw body>". DashCommerce passes providers a
 * single signature header, so the webhook route joins the two Coldtill headers into "t=<timestamp>,sha256=<hex>".
 */
export function joinSignatureHeader(timestamp: string, signatureV2: string): string {
	return `t=${timestamp.trim()},${signatureV2.trim().toLowerCase()}`;
}

export async function signPayload(rawBody: string, secret: string, timestamp: string): Promise<string> {
	const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
	return "sha256=" + toHex(await crypto.subtle.sign("HMAC", key, enc.encode(`${timestamp}.${rawBody}`)));
}

export async function verifySignature(
	input: VerifyWebhookInput,
	now = Math.floor(Date.now() / 1000),
): Promise<VerifyWebhookResult> {
	// Only the joined form is accepted. Coldtill's body-only X-Coldtill-Signature also reaches DashCommerce's
	// checkout/webhook route if someone posts there directly, and it carries no timestamp to stop replays.
	const m = /^t=(\d+),sha256=([0-9a-f]{64})$/.exec(input.signatureHeader.trim());
	if (!m) return { ok: false, reason: "malformed signature; point the Coldtill webhook at checkout/webhook-coldtill" };
	if (!input.secret) return { ok: false, reason: "webhook secret not configured" };
	const ts = m[1]!;
	if (Math.abs(now - Number(ts)) > SIGNATURE_TOLERANCE_SECONDS) return { ok: false, reason: "timestamp outside window" };
	const key = await crypto.subtle.importKey("raw", enc.encode(input.secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
	// crypto.subtle.verify compares in constant time.
	const valid = await crypto.subtle.verify("HMAC", key, fromHex(m[2]!)!, enc.encode(`${ts}.${input.rawBody}`));
	return valid ? { ok: true } : { ok: false, reason: "signature mismatch" };
}

function draftIdOf(event: PaymentEvent): string {
	const invoice = event.invoice_id ?? "";
	return invoice.startsWith(INVOICE_PREFIX) ? invoice.slice(INVOICE_PREFIX.length) : "";
}

export function parseEvent(rawBody: string): NormalizedPaymentEvent {
	let data: PaymentEvent;
	try {
		data = JSON.parse(rawBody) as PaymentEvent;
	} catch {
		return { type: "unhandled", providerEventType: "unparseable", raw: null };
	}
	const ref = data?.reference_id ?? "";
	const status = data?.status ?? "";
	const orderDraftId = data ? draftIdOf(data) : "";
	// Payout events, test deliveries and payments made outside DashCommerce have nothing to update here.
	if (!ref || !status || !orderDraftId) {
		return { type: "unhandled", providerEventType: data?.event ?? (status ? `payment.${status.toLowerCase()}` : "unknown"), raw: data };
	}
	// providerEventId stays empty on purpose. DashCommerce records the event id before it handles the event, so a
	// delivery that fails (Coldtill unreachable during the live re-check, say) would be dropped as a duplicate when
	// Coldtill retries it. Orders are still created once: DashCommerce looks the order up by paymentReference first.
	switch (status) {
		case "FILLED":
		case "OVER_FILLED":
			return {
				type: "charge.succeeded",
				orderDraftId,
				providerId: COLDTILL_PROVIDER_ID,
				providerEventId: "",
				checkoutReference: ref,
				paymentReference: ref,
				amount: usdToCents(data.amount ?? "0"),
				currency: "USD",
				customer: { email: "" },
				raw: data,
			};
		case "CANCELLED":
		case "REPLACED":
			return {
				type: "charge.failed",
				orderDraftId,
				providerId: COLDTILL_PROVIDER_ID,
				providerEventId: "",
				checkoutReference: ref,
				paymentReference: ref,
				reason: `Coldtill payment ${status.toLowerCase()}`,
				raw: data,
			};
		default:
			// OPEN and PARTIALLY_FILLED: wait for the payment to fill or close.
			return { type: "unhandled", providerEventType: `payment.${status.toLowerCase()}`, raw: data };
	}
}

/** Builds the provider for one Coldtill install. `baseUrl` is fixed in astro.config, next to allowedHosts. */
export function createColdtillProvider(baseUrl: string, timeoutMs = 20_000): PaymentProvider {
	const base = baseUrl.replace(/\/+$/, "");

	async function request<T>(
		ctx: PaymentProviderRuntimeContext,
		creds: PaymentProviderCredentials,
		method: string,
		path: string,
		body?: unknown,
	): Promise<T> {
		if (!ctx.http) throw new Error("DashCommerce has no network access; the plugin needs the network:request capability");
		const ctrl = new AbortController();
		const timer = setTimeout(() => ctrl.abort(), timeoutMs);
		try {
			const res = await ctx.http.fetch(`${base}/api/v1${path}`, {
				method,
				headers: {
					"API-Key": creds.secretKey,
					Accept: "application/json",
					...(body !== undefined ? { "Content-Type": "application/json" } : {}),
				},
				body: body !== undefined ? JSON.stringify(body) : undefined,
				signal: ctrl.signal,
			});
			const text = await res.text();
			let data: unknown = null;
			try {
				data = text ? JSON.parse(text) : null;
			} catch {
				// Leave data null; the status code below says what went wrong.
			}
			if (!res.ok) {
				const msg = (data as { error?: string } | null)?.error ?? `HTTP ${res.status}`;
				throw new ColdtillApiError(res.status, `Coldtill: ${msg}`);
			}
			return data as T;
		} finally {
			clearTimeout(timer);
		}
	}

	return {
		id: COLDTILL_PROVIDER_ID,
		label: "Crypto (Coldtill)",
		capabilities: { coupons: false, connect: false, subscriptions: false },

		// Coldtill prices payments in USD.
		supportsCurrency: (currency) => currency.toUpperCase() === "USD",

		async initCheckout(ctx, input: InitCheckoutInput, creds): Promise<InitCheckoutResult> {
			if (input.mode === "subscription") throw new Error("Coldtill does not support subscriptions");
			if (input.currency.toUpperCase() !== "USD") throw new Error("Coldtill only accepts USD carts");
			const req: Record<string, string> = {
				// Coldtill keeps one open payment per customer, so each checkout gets its own customer ID.
				customerID: `dashcommerce-${input.orderDraftId}`,
				amountInUSD: centsToUsd(input.amount),
				invoiceID: `${INVOICE_PREFIX}${input.orderDraftId}`,
			};
			if (input.customer.email) req.customerEmail = input.customer.email;
			// The success URL carries Stripe's {CHECKOUT_SESSION_ID} placeholder, which means nothing to Coldtill.
			const returnURL = input.successUrl.replace(/[?&]session_id=\{CHECKOUT_SESSION_ID\}$/, "");
			if (returnURL.startsWith("https://")) req.returnURL = returnURL;

			let res: { reference_id: string; url: string };
			try {
				res = await request(ctx, creds, "POST", "/payment", req);
			} catch (err) {
				// A project that limits return hosts rejects other stores; fall back to the project's Return URL.
				if (!req.returnURL || !(err instanceof ColdtillApiError) || err.status !== 400 || !err.message.includes("returnURL")) {
					throw err;
				}
				delete req.returnURL;
				res = await request(ctx, creds, "POST", "/payment", req);
			}
			return { kind: "redirect", checkoutReference: res.reference_id, redirectUrl: res.url };
		},

		verifyWebhook: (input) => verifySignature(input),

		parseWebhookEvent: parseEvent,

		async getPaymentStatus(ctx, paymentReference, creds): Promise<PaymentStatusResult> {
			const p = await request<ColdtillPayment>(ctx, creds, "GET", `/payment/reference/${encodeURIComponent(paymentReference)}`);
			const amount = usdToCents(p.amountInUSD);
			switch (p.paymentState) {
				case "FILLED":
				case "OVER_FILLED":
					return { status: "succeeded", paymentReference: p.referenceID, amount, currency: "USD" };
				case "CANCELLED":
				case "REPLACED":
					return { status: "failed", paymentReference: p.referenceID, amount, currency: "USD", reason: p.paymentState };
				default:
					return { status: "pending", paymentReference: p.referenceID, amount, currency: "USD" };
			}
		},

		async refund(): Promise<RefundResult> {
			throw new Error("Coldtill payments settle straight to your wallet. Send the refund from your wallet, then mark the order refunded.");
		},

		formatAmount: (amount, currency) =>
			new Intl.NumberFormat("en-US", { style: "currency", currency: currency.toUpperCase() }).format(amount / 100),
	};
}
