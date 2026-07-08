# SureSecured Email App — Setup Walkthrough (Non-Technical)

**Your Railway app URL:** `https://suresecured-email-production.up.railway.app`  
**Decisions log:** `DECISIONS.md`  
**Last updated:** 2026-07-08

**What you're doing:** Lock down the app, turn on email sending, connect Shopify so sales get credited, and log in as admin.

---

## Current status (as of 2026-07-08)

| Item | Status |
|------|--------|
| Railway app live | ✅ |
| Core variables (JWT, CRON, CLIENT_API_KEY, etc.) | ✅ |
| Admin login | ✅ `kmaautosinc@gmail.com` |
| Sending (Ionos SMTP) | ✅ `SES_SMTP_*` + `sales@suresecured.com` |
| Railway CLI linked | ✅ Project **Email-Campaign** |
| Email list cleaning | 📋 **You:** offline verify → CSV import (see Part 3) |
| Shopify webhook | 🔄 **You:** in progress |
| ZeroBounce in Railway | ⏭️ **Not needed** (see Part 3) |

---

## Before you start

1. Open **`YOUR_RAILWAY_VARS.txt`** in this folder (same directory as this file). It has ready-made passwords for most variables. **Do not email this file to anyone.**
2. Open [Railway](https://railway.app) in one browser tab and [Shopify Admin](https://admin.shopify.com) in another.
3. Pick your **admin password** now and write it in `YOUR_RAILWAY_VARS.txt` under `ADMIN_PASSWORD`.

---

## Part 1 — Add missing Railway variables (20 min)

### Step 1: Open Variables

1. Go to [railway.app](https://railway.app) → log in.
2. Open your project (SureSecured / email app).
3. Click the **service** that runs the Node app (not Postgres unless that's the only thing you see).
4. Click **Variables** in the top menu.

### Step 2: Add each variable

For **each row** in `YOUR_RAILWAY_VARS.txt` under "REQUIRED NOW":

1. Click **+ New Variable** (or **Raw Editor** if you prefer bulk paste).
2. **Variable name** = left column (e.g. `JWT_SECRET`).
3. **Value** = the line under it (no quotes).
4. Save.

Repeat until all of these exist:

| Variable | Value source |
|----------|----------------|
| JWT_SECRET | Already generated in YOUR_RAILWAY_VARS.txt |
| CRON_SECRET | Already generated |
| CLIENT_API_KEY | Already generated |
| TRACKER_URL | `https://suresecured-email-production.up.railway.app` |
| APP_BASE_URL | Same as TRACKER_URL |
| SITE_URL | `https://suresecured.com` |
| COOKIE_DOMAIN | `.suresecured.com` |
| ADMIN_EMAIL | Your login email (e.g. tim@suresecured.com) |
| ADMIN_PASSWORD | Password **you** choose |
| UNSUBSCRIBE_HMAC_SECRET | Already generated |
| TOKEN_ENCRYPTION_KEY | Already generated |

**Important:** If `CRON_SECRET` is missing, scheduled emails **will not send** (Railway cron calls your app every 15 minutes with this secret).

### Step 3: Redeploy

After saving variables, Railway usually redeploys automatically. If not:

1. Click **Deployments**.
2. Click **Redeploy** on the latest deployment.

Wait until status shows **Success** / **Active**.

---

## Part 2 — Create your admin login (5 min)

The app reads `ADMIN_EMAIL` and `ADMIN_PASSWORD` from Railway and creates your account when you run setup **once**.

### Option A — Railway dashboard (easiest)

1. In Railway → your app service → **Settings**.
2. Find **One-off command** or **Run command** (wording varies).
3. Run: `node src/setup.js`
4. Check logs — you should see: `Admin user ready: tim@suresecured.com` (or your email).

### Option B — Railway CLI (if you use terminal)

```bash
cd /path/to/Email_Suresecured
railway link
railway run node src/setup.js
```

### Step 4: Log in

1. Open: `https://suresecured-email-production.up.railway.app`
2. Log in with **ADMIN_EMAIL** + **ADMIN_PASSWORD**.
3. Change password in the app if there's a change-password screen.

---

## Part 3 — Clean your email list (offline, one time)

**Decision:** No ZeroBounce in the app — clean the list **before** CSV import using a bulk verifier website.

Full details: **`docs/DELIVERABILITY_RUNBOOK.md`**

### Steps

1. Export your leads to CSV (`email` column required).
2. Upload to **[MillionVerifier](https://www.millionverifier.com)** or **[Bouncer](https://www.usebouncer.com)** (~$40–65 for ~10k emails).
3. Download **Valid / Deliverable only**.
4. In SalesPilot → **Sequences** → **Import Contacts (CSV)** → upload cleaned file.
5. Imported leads are automatically **send-ready** (`preverified`).

### Pilot launch

- Enroll **500–1,000** leads first (not the full list).
- Watch **bounce rate** in Sequences for 48–72 hours.
- If bounce &lt; **~2%**, enroll the rest in batches.

### Optional: ZeroBounce in-app

Only if you later add `ZEROBOUNCE_API_KEY` to Railway and use **Verify Emails (50)** in the UI. **Not required** for launch.

---

## Part 4 — Shopify webhook + secret (10 min)

This tells the app when someone **buys** on suresecured.com so commission can be assigned.

1. Shopify Admin → **Settings** → **Notifications** → scroll to **Webhooks**.
2. **Create webhook**:
   - Event: **Order creation**
   - Format: **JSON**
   - URL: `https://suresecured-email-production.up.railway.app/webhooks/shopify/order`
     - Note: `/order` at the end — **not** `shopify-order`
3. Save. Shopify shows a **signing secret** (sometimes after creation — click the webhook to view).
4. Railway → Variables:
   - Name: `SHOPIFY_WEBHOOK_SECRET`
   - Value: paste signing secret
5. Redeploy.

### Give your Shopify developer (attribution snippet)

Send them **`shopify-handoff/snippet.js`** from this repo and ask them to:

1. Copy the `<script>...</script>` block.
2. Paste into **`layout/theme.liquid`** just before `</body>`.
3. Confirm `/pages/request-a-quote` and `/pages/become-a-dealer` are **native Shopify forms** (not Typeform/JotForm). If third-party, tell your dev so we can adjust.

Without the snippet, email clicks won't tie to Shopify orders.

---

## Part 5 — How emails send (in-house — confirmed)

**Decision B1:** Send from this app, not Mailchimp/Instantly.

Your Railway config uses **Ionos SMTP** (`SES_SMTP_*` variables). Send priority:

1. Per-client SMTP in admin (if set)
2. Global **Ionos/SMTP** settings (what you have now)
3. Per-rep **Gmail** (optional — Part 6)

### Checklist (already set in Railway)

- `SES_SMTP_HOST`, `SES_SMTP_USER`, `SES_SMTP_PASS`, `SES_SMTP_PORT`
- `SES_FROM_EMAIL` = `sales@suresecured.com`
- `SES_FROM_NAME` = `SureSecured`

### DNS

SPF + DKIM + DMARC for `sales@suresecured.com` via Ionos — ask whoever manages DNS.

### Rollout (decision B4)

- Pilot: **500–1,000** leads
- Scale only if bounce rate &lt; **~2%**

---

## Part 6 — Gmail OAuth (optional — when reps send from their own inbox)

Only needed if you want emails to come **from each salesperson's Gmail** instead of SES.

### Google Cloud Console

1. Go to [console.cloud.google.com](https://console.cloud.google.com).
2. Create or select a project.
3. **APIs & Services** → **Library** → enable **Gmail API**.
4. **APIs & Services** → **OAuth consent screen** → configure (External, add your email as test user if in testing mode).
5. **Credentials** → **Create credentials** → **OAuth client ID**:
   - Type: **Web application**
   - Authorized redirect URI:  
     `https://suresecured-email-production.up.railway.app/gmail/callback`
6. Copy **Client ID** and **Client secret**.

### Railway

Add:

| Variable | Value |
|----------|--------|
| GMAIL_CLIENT_ID | from Google |
| GMAIL_CLIENT_SECRET | from Google |
| GMAIL_REDIRECT_URI | `https://suresecured-email-production.up.railway.app/gmail/callback` |

Redeploy. In the admin app, each rep uses **Connect Gmail** (or similar) once.

---

## Part 7 — Optional webhook secrets (when ready)

| Variable | When |
|----------|------|
| CALLRAIL_WEBHOOK_SECRET | CallRail call tracking live |
| RETELL_WEBHOOK_SECRET | Lock down Retell voice webhooks |
| TELNYX_WEBHOOK_SECRET or TELNYX_PUBLIC_KEY | Lock down SMS webhooks |

If these are **missing** in production, those webhooks may reject requests (by design, for security).

---

## Part 8 — Verify everything works

### Health check

Open in browser:  
`https://suresecured-email-production.up.railway.app/health`  
Should return OK / healthy JSON.

### Cron (email sequences)

Railway runs every **15 minutes** and hits `/cron/send-sequences` with your `CRON_SECRET`. After you add leads to a sequence:

1. Wait up to 15 minutes, or
2. Ask dev to trigger manually:  
   `curl -X POST https://suresecured-email-production.up.railway.app/cron/send-sequences -H "Authorization: Bearer YOUR_CRON_SECRET"`

### Shopify test order

1. Click a tracked link from a test email (or use snippet + `?sp=TEST` if dev set that up).
2. Place a test order on the store.
3. In admin, confirm the order appears with a salesperson attributed.

---

## Quick reference — URLs

| What | URL |
|------|-----|
| Admin / tracker app | https://suresecured-email-production.up.railway.app |
| Shopify order webhook | https://suresecured-email-production.up.railway.app/webhooks/shopify/order |
| Gmail OAuth callback | https://suresecured-email-production.up.railway.app/gmail/callback |
| Your store | https://suresecured.com |

---

## What's done vs what you still do

### Done ✅

- Railway deployed and healthy
- Security variables set (`CLIENT_API_KEY`, `APP_BASE_URL`, etc.)
- Admin user created
- CSV import marks offline-cleaned lists as send-ready
- Webhook URL fixed in `TimQuestions.md`

### You still do

- **Shopify webhook** + signing secret (Part 4)
- **Offline list clean** + CSV import (Part 3)
- **DNS** for sending domain
- **Pilot send** 500–1k leads

---

*Launch decisions: `DECISIONS.md` · List cleaning: `docs/DELIVERABILITY_RUNBOOK.md`*
