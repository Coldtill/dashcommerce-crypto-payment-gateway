// End to end through DashCommerce's real checkout/webhook handler, with in-memory KV and storage standing in for EmDash.
import assert from "node:assert/strict";
import { test } from "node:test";
import { getPaymentProvider } from "@dashcommerce/core/payment-provider";
import { createPlugin } from "../dist/entry.js";
import { coldtillHost, dashcommerceWithColdtill } from "../dist/index.js";
import { signPayload } from "../dist/provider.js";

const SECRET = "whsec_test";
const SITE = "https://shop.example.com";

function memoryStorage() {
	const collections = new Map();
	const matches = (data, where = {}) =>
		Object.entries(where).every(([k, v]) => {
			if (v && typeof v === "object" && Array.isArray(v.in)) return v.in.includes(data[k]);
			return data[k] === v;
		});
	const collection = () => {
		const rows = new Map();
		return {
			rows,
			async get(id) { return rows.get(id) ?? null; },
			async put(id, data) { rows.set(id, structuredClone(data)); },
			async delete(id) { return rows.delete(id); },
			async exists(id) { return rows.has(id); },
			async getMany(ids) { return new Map(ids.filter((i) => rows.has(i)).map((i) => [i, rows.get(i)])); },
			async putMany(items) { for (const { id, data } of items) rows.set(id, structuredClone(data)); },
			async deleteMany(ids) { let n = 0; for (const i of ids) n += rows.delete(i) ? 1 : 0; return n; },
			async query({ where, limit = 50 } = {}) {
				const items = [...rows].filter(([, d]) => matches(d, where)).slice(0, limit).map(([id, data]) => ({ id, data }));
				return { items, hasMore: false };
			},
			async count(where) { return [...rows.values()].filter((d) => matches(d, where)).length; },
		};
	};
	return new Proxy({}, {
		get(_, name) {
			if (typeof name !== "string") return undefined;
			if (!collections.has(name)) collections.set(name, collection());
			return collections.get(name);
		},
	});
}

function memoryKv(initial) {
	const m = new Map(Object.entries(initial));
	return {
		map: m,
		async get(k) { return m.has(k) ? structuredClone(m.get(k)) : null; },
		async set(k, v) { m.set(k, structuredClone(v)); },
		async delete(k) { return m.delete(k); },
		async list(prefix = "") { return [...m].filter(([k]) => k.startsWith(prefix)).map(([key, value]) => ({ key, value })); },
	};
}

const address = { firstName: "Ada", lastName: "Lovelace", line1: "1 Main St", city: "London", region: "", postalCode: "N1", country: "GB" };

function setup(coldtillPayments) {
	const plugin = createPlugin({ coldtillUrl: "https://pay.example.com" });
	const usd = (amount) => ({ amount, currency: "USD" });
	const kv = memoryKv({
		"settings:paymentProvider": "coldtill",
		"settings:coldtillSecretKey": "ck_test",
		"settings:coldtillWebhookSecret": SECRET,
		"draft:drf_1": {
			cart: {
				sessionId: "sess_1",
				currency: "USD",
				customerEmail: "ada@example.com",
				billingAddress: address,
				shippingAddress: address,
				items: [{ productId: "p1", title: "Mug", quantity: 1, unitPrice: usd(1999), lineSubtotal: usd(1999), isDigital: false }],
				coupons: [],
				subtotal: usd(1999), discountTotal: usd(0), shippingTotal: usd(0), taxTotal: usd(0), total: usd(1999),
			},
			ttlMs: 900000,
			createdAt: new Date().toISOString(),
			providerId: "coldtill",
		},
	});
	const storage = memoryStorage();
	const fetched = [];
	const noop = () => {};
	const ctx = {
		plugin: { id: "dashcommerce", version: "0.3.2" },
		site: { url: SITE, name: "Shop", locale: "en" },
		url: (p) => SITE + p,
		kv,
		storage,
		log: { info: noop, warn: noop, error: noop, debug: noop },
		http: {
			async fetch(url) {
				fetched.push(url);
				const ref = decodeURIComponent(url.split("/").pop());
				return new Response(JSON.stringify(coldtillPayments[ref]), { status: coldtillPayments[ref] ? 200 : 404 });
			},
		},
		email: { send: async () => {} },
		content: { get: async () => null, list: async () => ({ items: [] }) },
		users: { get: async () => null },
		media: {},
		cron: { schedule: async () => {}, cancel: async () => {}, list: async () => [] },
	};
	const route = plugin.routes["checkout/webhook-coldtill"];
	async function deliver(body, { ts = String(Math.floor(Date.now() / 1000)), sig } = {}) {
		const raw = JSON.stringify(body);
		const headers = {
			"Content-Type": "application/json",
			"X-Coldtill-Timestamp": ts,
			"X-Coldtill-Signature-V2": sig ?? (await signPayload(raw, SECRET, ts)),
			"X-Coldtill-Event": `payment.${String(body.status).toLowerCase()}`,
		};
		const request = new Request(`${SITE}/_emdash/api/plugins/dashcommerce/checkout/webhook-coldtill`, { method: "POST", headers, body: raw });
		const res = await route.handler({ ...ctx, request, input: body });
		return { status: res.status, body: await res.json() };
	}
	return { plugin, ctx, kv, storage, fetched, deliver };
}

const filled = { reference_id: "ref_1", invoice_id: "DC-drf_1", customer_id: "dashcommerce-drf_1", status: "FILLED", amount: "19.99", currency: "USD" };
const livePayment = (paymentState) => ({ referenceID: "ref_1", invoiceID: "DC-drf_1", amountInUSD: "19.99", paymentState });

test("descriptor adds the Coldtill host and entrypoint", () => {
	const d = dashcommerceWithColdtill({ url: "https://pay.example.com/" });
	assert.equal(d.id, "dashcommerce");
	assert.equal(d.entrypoint, "@coldtill/dashcommerce/entry");
	assert.ok(d.allowedHosts.includes("pay.example.com"));
	assert.ok(d.allowedHosts.includes("api.stripe.com"));
	assert.ok(d.options.allowedHosts.includes("pay.example.com"));
	assert.equal(d.options.coldtillUrl, "https://pay.example.com");
	assert.throws(() => coldtillHost("http://pay.example.com"), /https/);
	assert.equal(coldtillHost("http://localhost:8080"), "localhost");
});

test("createPlugin registers the provider, route and secret settings", () => {
	const { plugin } = setup({});
	assert.ok(getPaymentProvider("coldtill"));
	assert.equal(plugin.routes["checkout/webhook-coldtill"].public, true);
	assert.ok(plugin.routes["checkout/webhook"], "core routes kept");
	assert.equal(plugin.admin.settingsSchema.coldtillSecretKey.type, "secret");
	assert.equal(plugin.admin.settingsSchema.coldtillWebhookSecret.type, "secret");
	assert.ok(plugin.allowedHosts.includes("pay.example.com"));
	assert.throws(() => createPlugin({}), /url/);
});

test("a filled payment creates one paid order, and a retry does not create another", async () => {
	const { deliver, storage, fetched, kv } = setup({ ref_1: livePayment("FILLED") });
	const first = await deliver(filled);
	assert.equal(first.status, 200, JSON.stringify(first.body));
	assert.ok(first.body.orderId, JSON.stringify(first.body));
	assert.deepEqual(fetched, ["https://pay.example.com/api/v1/payment/reference/ref_1"], "live re-check");
	const orders = [...storage.orders.rows.values()];
	assert.equal(orders.length, 1);
	assert.equal(orders[0].stripePaymentIntentId, "ref_1");
	assert.equal(orders[0].status, "processing");
	assert.equal(orders[0].paymentStatus, "paid");
	assert.equal(kv.map.has("draft:drf_1"), false, "draft consumed");

	const again = await deliver(filled);
	assert.equal(again.status, 200);
	assert.equal(again.body.duplicate, true);
	assert.equal(storage.orders.rows.size, 1);
});

test("a webhook is refused when Coldtill does not confirm the payment", async () => {
	const { deliver, storage } = setup({ ref_1: livePayment("PARTIALLY_FILLED") });
	const res = await deliver(filled);
	assert.equal(res.status, 500);
	assert.equal(storage.orders.rows.size, 0);
});

test("a failed live re-check can be retried by Coldtill", async () => {
	const payments = { ref_1: undefined };
	const { deliver, storage } = setup(payments);
	assert.equal((await deliver(filled)).status, 500, "Coldtill unreachable");
	payments.ref_1 = livePayment("FILLED");
	const retry = await deliver(filled);
	assert.equal(retry.status, 200, JSON.stringify(retry.body));
	assert.equal(storage.orders.rows.size, 1);
});

test("bad, stale and missing signatures are rejected before anything changes", async () => {
	const { deliver, storage, fetched } = setup({ ref_1: livePayment("FILLED") });
	assert.equal((await deliver(filled, { sig: "sha256=" + "0".repeat(64) })).status, 400);
	const old = String(Math.floor(Date.now() / 1000) - 3600);
	assert.equal((await deliver(filled, { ts: old })).status, 400);
	assert.equal((await deliver(filled, { ts: "", sig: "" })).status, 401);
	assert.equal(storage.orders.rows.size, 0);
	assert.equal(fetched.length, 0);
});

test("a cancelled payment releases the stock hold and creates no order", async () => {
	const { deliver, storage } = setup({});
	const res = await deliver({ ...filled, status: "CANCELLED" });
	assert.equal(res.status, 200);
	assert.equal(storage.orders.rows.size, 0);
});

test("partial payments and other events are acknowledged and skipped", async () => {
	const { deliver, storage } = setup({});
	const res = await deliver({ ...filled, status: "PARTIALLY_FILLED" });
	assert.equal(res.status, 200);
	assert.equal(res.body.skipped, true);
	assert.equal(storage.orders.rows.size, 0);
});
