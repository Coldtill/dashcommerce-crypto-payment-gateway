import assert from "node:assert/strict";
import { test } from "node:test";
import {
	centsToUsd,
	createColdtillProvider,
	joinSignatureHeader,
	parseEvent,
	signPayload,
	usdToCents,
	verifySignature,
} from "../dist/provider.js";

const SECRET = "whsec_test";
const now = () => Math.floor(Date.now() / 1000);

/** A fake ctx.http that records requests and answers from a queue. */
function fakeCtx(...responses) {
	const calls = [];
	return {
		calls,
		log: { info() {}, warn() {}, error() {} },
		http: {
			async fetch(url, init) {
				calls.push({ url, ...init, body: init.body ? JSON.parse(init.body) : undefined });
				const [status, body] = responses.shift();
				return new Response(JSON.stringify(body), { status });
			},
		},
	};
}

const creds = { secretKey: "ck_live_123", webhookSecret: SECRET };

const checkoutInput = {
	orderDraftId: "drf_abc",
	amount: 1999,
	currency: "USD",
	customer: { email: "buyer@example.com" },
	lineItems: [],
	successUrl: "https://shop.example.com/thank-you/drf_abc?session_id={CHECKOUT_SESSION_ID}",
	cancelUrl: "https://shop.example.com/cart",
	mode: "payment",
};

test("cents convert both ways without float error", () => {
	assert.equal(centsToUsd(1999), "19.99");
	assert.equal(centsToUsd(5), "0.05");
	assert.equal(centsToUsd(100000), "1000.00");
	assert.equal(usdToCents("19.99"), 1999);
	assert.equal(usdToCents("0.1"), 10);
	assert.equal(usdToCents("12"), 1200);
	assert.equal(usdToCents("1.005"), 101);
	assert.throws(() => centsToUsd(1.5));
	assert.throws(() => usdToCents("-1"));
});

test("initCheckout creates a USD payment and returns the hosted checkout", async () => {
	const p = createColdtillProvider("https://pay.example.com/");
	const ctx = fakeCtx([200, { host: "pay.example.com", reference_id: "ref_1", url: "https://pay.example.com/pay/ref_1" }]);
	const res = await p.initCheckout(ctx, checkoutInput, creds);
	assert.deepEqual(res, { kind: "redirect", checkoutReference: "ref_1", redirectUrl: "https://pay.example.com/pay/ref_1" });
	const [call] = ctx.calls;
	assert.equal(call.url, "https://pay.example.com/api/v1/payment");
	assert.equal(call.method, "POST");
	assert.equal(call.headers["API-Key"], "ck_live_123");
	assert.deepEqual(call.body, {
		customerID: "dashcommerce-drf_abc",
		amountInUSD: "19.99",
		invoiceID: "DC-drf_abc",
		customerEmail: "buyer@example.com",
		returnURL: "https://shop.example.com/thank-you/drf_abc",
	});
});

test("initCheckout retries without returnURL when the project limits return hosts", async () => {
	const p = createColdtillProvider("https://pay.example.com");
	const ctx = fakeCtx(
		[400, { error: "returnURL host is not allowed" }],
		[200, { reference_id: "ref_2", url: "https://pay.example.com/pay/ref_2" }],
	);
	const res = await p.initCheckout(ctx, checkoutInput, creds);
	assert.equal(res.checkoutReference, "ref_2");
	assert.equal(ctx.calls.length, 2);
	assert.equal(ctx.calls[1].body.returnURL, undefined);
});

test("initCheckout surfaces other API errors", async () => {
	const p = createColdtillProvider("https://pay.example.com");
	await assert.rejects(p.initCheckout(fakeCtx([401, { error: "invalid API key" }]), checkoutInput, creds), /invalid API key/);
});

test("initCheckout refuses non-USD carts and subscriptions", async () => {
	const p = createColdtillProvider("https://pay.example.com");
	assert.equal(p.supportsCurrency("usd"), true);
	assert.equal(p.supportsCurrency("EUR"), false);
	await assert.rejects(p.initCheckout(fakeCtx(), { ...checkoutInput, currency: "EUR" }, creds), /USD/);
	await assert.rejects(p.initCheckout(fakeCtx(), { ...checkoutInput, mode: "subscription" }, creds), /subscriptions/);
});

test("verifySignature accepts a fresh v2 signature and rejects the rest", async () => {
	const body = JSON.stringify({ reference_id: "ref_1", status: "FILLED" });
	const ts = String(now());
	const header = joinSignatureHeader(ts, await signPayload(body, SECRET, ts));
	assert.deepEqual(await verifySignature({ rawBody: body, signatureHeader: header, secret: SECRET }), { ok: true });

	const bad = async (h, b = body, s = SECRET) => (await verifySignature({ rawBody: b, signatureHeader: h, secret: s })).ok;
	assert.equal(await bad(header, body + " "), false, "tampered body");
	assert.equal(await bad(header, body, "other"), false, "wrong secret");
	assert.equal(await bad(header, body, ""), false, "no secret");
	assert.equal(await bad((await signPayload(body, SECRET, ts)).slice(0)), false, "v1-style header without timestamp");
	const old = String(now() - 600);
	assert.equal(await bad(joinSignatureHeader(old, await signPayload(body, SECRET, old))), false, "replayed old delivery");
});

test("parseEvent maps Coldtill payment states", () => {
	const ev = (status, extra = {}) =>
		parseEvent(JSON.stringify({ reference_id: "ref_1", invoice_id: "DC-drf_abc", status, amount: "19.99", ...extra }));
	for (const s of ["FILLED", "OVER_FILLED"]) {
		const e = ev(s);
		assert.equal(e.type, "charge.succeeded");
		assert.equal(e.orderDraftId, "drf_abc");
		assert.equal(e.paymentReference, "ref_1");
		assert.equal(e.amount, 1999);
		assert.equal(e.currency, "USD");
		assert.equal(e.providerEventId, "");
	}
	for (const s of ["CANCELLED", "REPLACED"]) assert.equal(ev(s).type, "charge.failed");
	for (const s of ["OPEN", "PARTIALLY_FILLED"]) assert.equal(ev(s).type, "unhandled");
	assert.equal(ev("FILLED", { invoice_id: "WC-12" }).type, "unhandled", "payment from another integration");
	assert.equal(parseEvent("not json").type, "unhandled");
	assert.equal(parseEvent(JSON.stringify({ event: "test" })).type, "unhandled");
});

test("getPaymentStatus re-checks the payment live", async () => {
	const p = createColdtillProvider("https://pay.example.com");
	const payment = (paymentState) => [200, { referenceID: "ref_1", amountInUSD: "19.99", paymentState }];
	const ctx = fakeCtx(payment("FILLED"), payment("PARTIALLY_FILLED"), payment("CANCELLED"));
	assert.deepEqual(await p.getPaymentStatus(ctx, "ref_1", creds), { status: "succeeded", paymentReference: "ref_1", amount: 1999, currency: "USD" });
	assert.equal((await p.getPaymentStatus(ctx, "ref_1", creds)).status, "pending");
	assert.equal((await p.getPaymentStatus(ctx, "ref_1", creds)).status, "failed");
	assert.equal(ctx.calls[0].url, "https://pay.example.com/api/v1/payment/reference/ref_1");
	assert.equal(ctx.calls[0].method, "GET");
});

test("refunds point the merchant at their wallet", async () => {
	const p = createColdtillProvider("https://pay.example.com");
	await assert.rejects(p.refund(fakeCtx(), {}, creds), /wallet/);
	assert.equal(p.formatAmount(1999, "usd"), "$19.99");
});
