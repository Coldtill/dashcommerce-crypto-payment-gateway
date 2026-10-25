/**
 * DashCommerce with Coldtill crypto payments. Use it in astro.config.mjs in place of `dashcommerce()`:
 *
 *   import { dashcommerceWithColdtill } from "@coldtill/dashcommerce";
 *
 *   emdash({
 *     plugins: [dashcommerceWithColdtill({ url: "https://pay.example.com" })],
 *   });
 *
 * The descriptor is DashCommerce's own with the entrypoint pointed at this package and the Coldtill host added to
 * allowedHosts. EmDash fixes allowed hosts at build time, which is why the Coldtill URL is set here and not in the
 * admin.
 */

import { dashcommerce } from "@dashcommerce/core";
import type { PluginDescriptor } from "emdash";

export interface ColdtillOptions {
	/** Public URL of your Coldtill install, e.g. https://pay.example.com */
	url: string;
	/** DashCommerce plugin id, if you changed it from "dashcommerce". */
	id?: string;
}

/** Only https keeps the API key private on the way to Coldtill; plain http is accepted for localhost testing. */
export function coldtillHost(url: string): string {
	let u: URL;
	try {
		u = new URL(url);
	} catch {
		throw new Error(`@coldtill/dashcommerce: "${url}" is not a URL`);
	}
	const local = u.hostname === "localhost" || u.hostname === "127.0.0.1";
	if (u.protocol !== "https:" && !(u.protocol === "http:" && local)) {
		throw new Error("@coldtill/dashcommerce: the Coldtill URL must start with https:// so the API key is not sent in the clear");
	}
	return u.hostname;
}

export function dashcommerceWithColdtill(options: ColdtillOptions): PluginDescriptor {
	const host = coldtillHost(options.url);
	const base = dashcommerce(options.id ? { id: options.id } : {});
	const baseOptions = (base.options ?? {}) as { allowedHosts?: string[] };
	const allowedHosts = [...new Set([...(base.allowedHosts ?? []), host])];
	return {
		...base,
		entrypoint: "@coldtill/dashcommerce/entry",
		allowedHosts,
		options: {
			...baseOptions,
			allowedHosts: [...new Set([...(baseOptions.allowedHosts ?? []), host])],
			coldtillUrl: options.url.replace(/\/+$/, ""),
		},
	} as PluginDescriptor;
}

export { COLDTILL_PROVIDER_ID, createColdtillProvider } from "./provider.js";
export default dashcommerceWithColdtill;
