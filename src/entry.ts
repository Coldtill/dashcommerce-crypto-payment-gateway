/**
 * Replacement for DashCommerce's `@dashcommerce/core/sandbox` entrypoint. It builds the same plugin (id
 * "dashcommerce", same storage, hooks and admin) and adds:
 *
 *   1. the Coldtill PaymentProvider, registered for this site's Coldtill URL;
 *   2. the public route `checkout/webhook-coldtill`, where Coldtill sends its webhooks;
 *   3. the Coldtill host in allowedHosts;
 *   4. the API key and webhook secret as encrypted EmDash settings.
 *
 * Coldtill sends HMAC-SHA256 over "<timestamp>.<body>" in two headers. DashCommerce's own `checkout/webhook` passes a
 * provider one signature header, so the Coldtill route joins the two and forwards the request there unchanged.
 * Everything after that (signature check, live re-check, draft lookup, order creation, stock release) is DashCommerce.
 */

import { createPlugin as coreCreatePlugin, ROUTES, toNativeRoutes, type CreatePluginOptions } from "@dashcommerce/core/sandbox";
import { registerPaymentProvider } from "@dashcommerce/core/payment-provider";
import { COLDTILL_PROVIDER_ID, createColdtillProvider, joinSignatureHeader } from "./provider.js";

export interface ColdtillEntryOptions extends CreatePluginOptions {
	/** Public URL of the Coldtill install, e.g. https://pay.example.com. Set by `dashcommerceWithColdtill()`. */
	coldtillUrl?: string;
}

export const COLDTILL_SETTINGS_SCHEMA = {
	coldtillSecretKey: {
		type: "secret" as const,
		label: "Coldtill API key",
		description: "Project API key from Coldtill → API keys.",
	},
	coldtillWebhookSecret: {
		type: "secret" as const,
		label: "Coldtill webhook secret",
		description:
			"In Coldtill → Webhooks, set the URL to https://<your shop>/_emdash/api/plugins/dashcommerce/checkout/webhook-coldtill and paste the signing secret here.",
	},
};

type RouteContext = Parameters<(typeof ROUTES)[string]["handler"]>[0];
type PluginContext = Parameters<(typeof ROUTES)[string]["handler"]>[1];

/** Servers send each header as X-Coldtill-* and as the pre-rename X-Keyhold-*. */
function coldtillHeader(h: Headers, name: string): string {
	return h.get(`x-coldtill-${name}`) ?? h.get(`x-keyhold-${name}`) ?? "";
}

function json(body: unknown, status: number): Response {
	return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

export const coldtillRoutes = {
	"checkout/webhook-coldtill": {
		public: true,
		handler: async (routeCtx: RouteContext, ctx: PluginContext) => {
			const core = ROUTES["checkout/webhook"];
			if (!core) return json({ error: "DashCommerce checkout/webhook route not found" }, 500);
			const req = routeCtx.request;
			const ts = coldtillHeader(req.headers, "timestamp");
			const sig = coldtillHeader(req.headers, "signature-v2");
			if (!ts || !sig) return json({ error: "Missing X-Coldtill-Timestamp or X-Coldtill-Signature-V2" }, 401);

			const body = await req.clone().text();
			const url = new URL(req.url);
			url.pathname = url.pathname.replace(/webhook-coldtill$/, "webhook");
			url.search = `?provider=${COLDTILL_PROVIDER_ID}`;
			// Only the signature header is forwarded, so DashCommerce can't pick another provider from a stray header.
			const forwarded = new Request(url, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					[`x-${COLDTILL_PROVIDER_ID}-signature`]: joinSignatureHeader(ts, sig),
				},
				body,
			});
			let input: unknown = null;
			try {
				input = JSON.parse(body);
			} catch {
				// DashCommerce reads the raw body itself and rejects bad JSON after the signature check.
			}
			return core.handler({ ...routeCtx, request: forwarded, input } as RouteContext, ctx);
		},
	},
};

/**
 * Called by EmDash with the descriptor's options (see index.ts). Must stay synchronous.
 */
export function createPlugin(options: ColdtillEntryOptions = {}) {
	const { coldtillUrl, ...coreOptions } = options;
	if (!coldtillUrl) throw new Error("@coldtill/dashcommerce: pass { url } to dashcommerceWithColdtill() in astro.config");

	// Vite can evaluate this module more than once in dev, and this package owns the "coldtill" id, so override.
	registerPaymentProvider(createColdtillProvider(coldtillUrl), { override: true });

	const host = new URL(coldtillUrl).hostname;
	const plugin = coreCreatePlugin({
		...coreOptions,
		allowedHosts: [...new Set([...(coreOptions.allowedHosts ?? ["api.stripe.com", "files.stripe.com"]), host])],
	});
	const p = plugin as unknown as { routes: Record<string, unknown>; admin?: Record<string, unknown> };
	p.routes = { ...p.routes, ...toNativeRoutes(coldtillRoutes) };
	p.admin = {
		...p.admin,
		settingsSchema: { ...((p.admin?.settingsSchema as object | undefined) ?? {}), ...COLDTILL_SETTINGS_SCHEMA },
	};
	return plugin;
}

export default createPlugin;
