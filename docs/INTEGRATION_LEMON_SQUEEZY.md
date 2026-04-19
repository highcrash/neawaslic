# Lemon Squeezy → neawaslic integration

Wire Lemon Squeezy so every paid order auto-mints a purchase code
and emails it to the buyer. One-time setup, fully hands-off after.

## Overview

```
Buyer clicks "Buy now" on landing
    ↓
Lemon Squeezy checkout (hosted)
    ↓ payment succeeds
Lemon Squeezy fires order_created webhook
    ↓
POST https://api.neawaslic.top/api/v1/webhooks/lemon-squeezy
    ↓ neawaslic mints purchase code
Lemon Squeezy receipt email contains: {{custom.license_code}}
    ↓
Buyer activates via admin → Settings → License
```

Two secrets involved:
- **`LEMON_SQUEEZY_WEBHOOK_SECRET`** on the neawaslic droplet
- **Webhook signing secret** in the Lemon Squeezy dashboard

They must match byte-for-byte. Rotate together if either leaks.

## One-time setup

### 1. Products in Lemon Squeezy

For each SKU you sell (Single Restaurant, Bundle, Multi-Tenant):

1. Lemon Squeezy → Store → Products → **New product**
2. Name it + set the price
3. **Custom data** (under Advanced): add these key-value pairs:
   - `product_sku` → the matching SKU in neawaslic
     (e.g. `restora-pos-cc` for Single Restaurant,
     `restora-pos-bundle` for Bundle, `restora-pos-saas` for Multi-Tenant)
   - `max_activations` → `1` for Single Restaurant,
     `1` for Bundle (same code powers both web + desktop),
     `100` for Multi-Tenant (or whatever seat count you sold)

   Lemon Squeezy passes `custom_data` through to the webhook so
   neawaslic knows which product to mint a code for.

### 2. Products in neawaslic

Each `product_sku` you used above must exist as a Product row on
the license server. Log in to https://admin.neawaslic.top →
Products → **Create product** for each SKU.

Note the SKU matches EXACTLY — case-sensitive, no typos. Best to
copy-paste from the neawaslic admin into the Lemon Squeezy custom
data field.

### 3. Webhook secret

1. Generate a strong secret:
   ```bash
   node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
   ```
2. On the droplet at `neawaslic.top`, append to
   `/opt/neawaslic/infra/license-droplet/.env.secrets`:
   ```
   LEMON_SQUEEZY_WEBHOOK_SECRET=<paste the generated secret>
   ```
3. Restart the license server:
   ```bash
   ssh root@<droplet>
   cd /opt/neawaslic/infra/license-droplet
   docker compose restart license-server
   ```

### 4. Webhook endpoint in Lemon Squeezy

1. Lemon Squeezy → Settings → Webhooks → **Add endpoint**
2. **URL:** `https://api.neawaslic.top/api/v1/webhooks/lemon-squeezy`
3. **Signing secret:** paste the SAME value you set in
   `LEMON_SQUEEZY_WEBHOOK_SECRET`
4. **Events:** select `order_created` and `subscription_created`
   only. Unchecking the others avoids noise; our endpoint
   gracefully 200s anything it doesn't handle, but fewer
   deliveries = less log spam.
5. Save.

### 5. Receipt email: include the license code

1. Lemon Squeezy → Store → Settings → **Emails**
2. Edit "Order confirmation" → add a section with:
   ```
   Your license code:
   {{custom.license_code}}
   ```
3. This populates automatically from the webhook response — the
   code our endpoint returns is stored on the order under
   `custom.license_code` and the template variable resolves at
   send time.

## Test it

Lemon Squeezy has a sandbox mode. In the dashboard:

1. Store → **Enable test mode** (top-right toggle)
2. Visit your product's buy link as a customer
3. Pay with the test card `4242 4242 4242 4242` / any future date
4. Check:
   - Lemon Squeezy webhook log: 200 response from neawaslic
   - neawaslic admin → Logs: new ACTIVATE entry with
     `result: webhook-issued:XXXX-XXXX-...`
   - neawaslic admin → Purchase codes: new row with
     `source: WEBHOOK`
   - Buyer's test email: contains the license code

Idempotency is verified by **replaying the same webhook** from
Lemon Squeezy's dashboard. Expected: the endpoint returns the
SAME code instead of minting a new one.

## Failure modes

| Symptom | Cause | Fix |
| ------- | ----- | --- |
| 401 `MISSING_SIGNATURE` in Lemon Squeezy logs | Webhook endpoint misconfigured (no signing secret set on LS side) | Settings → Webhooks → edit endpoint → set signing secret |
| 401 `BAD_SIGNATURE` | Mismatched secret between LS + neawaslic | Regenerate, update BOTH sides, restart license-server |
| 401 `WEBHOOK_NOT_CONFIGURED` | `LEMON_SQUEEZY_WEBHOOK_SECRET` env missing on droplet | Check `.env.secrets` + `docker compose restart license-server` |
| 404 `PRODUCT_NOT_FOUND` | `product_sku` on LS custom_data doesn't match any Product SKU in neawaslic | Verify exact string (case-sensitive) in both places |
| 500 anything | Bug in our endpoint — check `docker compose logs license-server` | Collect log + the webhook payload from LS, send to support |

## Other providers

The webhook endpoint is Lemon-Squeezy-specific (signature format,
event name, payload shape). Adding Gumroad / Paddle / Stripe is
a copy-paste of `webhook.controller.ts` with the provider's:
- Signature algorithm (most use HMAC-SHA256 on the raw body)
- Event name (`order_created` equivalent)
- Payload field for the identifier (order ID)
- Payload field for the product (SKU or variant)

See `apps/license-server/src/webhook/webhook.service.ts` —
`handleLemonSqueezy` is the template. The core issue-code logic
is provider-agnostic; only parsing + signature check vary.
