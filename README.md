# DashCommerce crypto payment gateway: Coldtill for DashCommerce

**Accept USDT, USDC, Bitcoin, Ethereum, Solana, Tron and 200+ coins in your EmDash shop, straight to your own wallets.**
No sign-up, no KYB, no custody and no processor that can freeze your money.

This package adds [Coldtill](https://coldtill.com) as a payment method to [DashCommerce](https://github.com/emdashCommerce/dashcommerce),
the commerce plugin for [EmDash](https://emdashcms.com). Coldtill is a
[self-hosted crypto payment gateway](https://github.com/Coldtill/self-hosted-crypto-payment-gateway) that runs on
your own server.

[Download](https://github.com/Coldtill/dashcommerce-crypto-payment-gateway/releases/latest/download/coldtill-dashcommerce.tgz) ·
[Coldtill](https://coldtill.com) · [Docs](https://coldtill.com/docs/) · [Live demo dashboard](https://demo.coldtill.com/) ·
[Other integrations](https://coldtill.com/integrations/)

![Coldtill checkout: choose a network and coin, then scan the QR code](https://coldtill.com/img/checkout-pay.webp)

## Features

- **200+ coins on 35+ chains.** BTC, ETH, SOL, TRX, BNB, POL, USDT and USDC directly, and XRP, TON, Sui, Cardano,
  Dogecoin and more through auto-convert, settled to you as USDC or USDT.
- **Self-custody.** On Ethereum, Base, Polygon, BNB Chain, Tron and Solana each customer pays into a deposit contract
  that can only send to your cold wallet. Bitcoin goes to your own wallet's addresses.
- **No account to freeze.** No sign-up, no KYC or KYB, no reserves and no payout schedule.
- **Uses DashCommerce's own checkout.** Carts, stock holds, order numbers, emails and the admin work as they do with
  Stripe. Coldtill is one more provider next to it.
- **Signed webhooks** (HMAC-SHA256 with a timestamp and a five-minute replay window), and every payment is re-checked
  with your Coldtill server before DashCommerce creates the order.

## Requirements

- EmDash 1.1 to 1.3 with `@dashcommerce/core` 0.3, including the EmDash patch DashCommerce ships
- Store currency: USD
- A running Coldtill server reachable over https. The Free edition installs with one command:

```bash
curl -fsSL https://coldtill.com/install.sh | sudo bash -s -- --edition free
```

## Install

1. Add the package to your EmDash site:

   ```bash
   npm install https://github.com/Coldtill/dashcommerce-crypto-payment-gateway/releases/latest/download/coldtill-dashcommerce.tgz
   ```

2. In `astro.config.mjs`, replace `dashcommerce()` with `dashcommerceWithColdtill()` and pass your Coldtill URL:

   ```js
   import { dashcommerceWithColdtill } from "@coldtill/dashcommerce";

   emdash({
     // …database, storage, sandboxRunner as before
     plugins: [dashcommerceWithColdtill({ url: "https://pay.example.com" })],
   });
   ```

   EmDash fixes the hosts a plugin may call when the site is built, so the URL goes here, not in the admin.
   It must start with `https://` (`http://localhost` works for testing).

3. Set `EMDASH_ENCRYPTION_KEY` if you have not already. EmDash needs it to store the API key encrypted.
4. In Coldtill, create a project API key (**API keys**).
5. In Coldtill → **Webhooks**, set the URL to
   `https://<your shop>/_emdash/api/plugins/dashcommerce/checkout/webhook-coldtill` and copy the signing secret.
6. In EmDash → **Plugins → DashCommerce → Settings**, paste the API key and webhook secret.
7. In DashCommerce → **Settings**, set the payment provider to `coldtill`. Stripe stays configured, so you can switch
   back at any time.

Use the hosted checkout mode. Coldtill has no embedded card form.

## What happens to an order

DashCommerce creates the order only once the payment is paid, the same as with hosted Stripe Checkout.

| Coldtill payment | DashCommerce |
|---|---|
| Filled or overpaid | Order created as Processing, paid |
| Partially paid | Nothing yet; the cart waits for the rest |
| Cancelled or replaced | Stock hold released; no order |

If the amount Coldtill reports doesn't match the cart, DashCommerce puts the order on hold.

Things to know:

- **Refunds** go from your wallet, since the money is already there. Mark the order refunded in DashCommerce
  afterwards; the refund button reports that Coldtill can't send refunds.
- **Slow payments.** DashCommerce holds stock for 15 minutes, while a Coldtill payment stays open for your project's
  expiry (24 hours by default). The order is still created when a late payment fills, but the stock may have sold in
  the meantime. Shorten the expiry in Coldtill if that matters for your shop.
- **A partial payment that is then cancelled** creates no order. The money is in your wallet; settle it with the
  customer from the payment in Coldtill.

## Development

```bash
npm install
npm test        # builds, then runs unit tests and an end-to-end test through DashCommerce's webhook handler
npm run typecheck
```

## Security

Report vulnerabilities to [security@coldtill.com](mailto:security@coldtill.com). See
[coldtill.com/security](https://coldtill.com/security).

## Licence

MIT. See [LICENSE](LICENSE).
