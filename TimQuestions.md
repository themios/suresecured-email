Here are all the open questions for the website developer:

> **Launch status (2026-07-08):** In-house sending confirmed. Shopify webhook in progress.  
> **Decisions:** `DECISIONS.md` · **Setup:** `SETUP_WALKTHROUGH_FOR_TIM.md`

For the Shopify Developer — suresecured.com

1. Install the tracking snippet

File: shopify-handoff/snippet.js (in this repo)
Action: copy the <script>…</script> block into layout/theme.liquid just before </body>
One file, one paste, done
2. Set up the Shopify order webhook

Shopify Admin → Settings → Notifications → Webhooks
Create webhook: Order creation → URL: https://suresecured-email-production.up.railway.app/webhooks/shopify/order
Copy the webhook signing secret → give it to you so you can add SHOPIFY_WEBHOOK_SECRET to Railway vars
3. Confirm the quote form type

Is /pages/request-a-quote a native Shopify contact form, or a third-party embed (Typeform, JotForm, etc.)?
If native Shopify: snippet handles it automatically
If third-party: need to know the platform so we can confirm the hidden field injection works
4. Confirm /pages/become-a-dealer same question

Same as above — native Shopify form or third-party embed?
That's it. Items 1 and 2 are required for attribution to work. Items 3 and 4 are a quick confirm — if both forms are native Shopify, no extra work needed.

WHAT IS THE PURPOSE? MAINLY SALESPERSON COMMISSION TRACKING?
No — commissions are a byproduct. The main purpose is reactivating dead leads and getting them to buy.

Here's the full picture:

Core job:
A trades business has hundreds of old leads — people who asked for a quote, never bought. SalesPilot imports those leads and automatically sends a multi-step email + SMS sequence from the salesperson's own Gmail. When someone clicks a link, replies, or calls, the system knows who they are and who to credit.

What it tracks and why:

Email opens/clicks → tells you who's warm, so the salesperson can follow up manually
Replies → pauses the sequence, AI classifies the reply (hot lead, interested, needs quote, etc.), notifies the salesperson immediately
Phone calls → inbound call via Retell AI agent, routed by extension to the right salesperson
Shopify purchases → cookie tracks which email → which lead → which salesperson → order
Commissions → calculated automatically from purchases, so the owner knows who closed what
The SaaS pitch in one line:
"Give us your dead leads. We'll send emails for you. You answer the replies and book the jobs."

Commissions matter more in the agency model (Tim running it for clients) so the owner can see ROI per salesperson. In the self-serve SaaS model, the business owner IS the salesperson, so it becomes more about pipeline visibility — who responded, who's hot, who to call today.

I MEANT WHAT IS THE PURPOSE OF THE WEBSITE QUESTIONS?
To track which salesperson's email caused a visitor to come to suresecured.com and buy — so the right person gets credit for the sale.

Without the snippet on the website, a customer can click the email link, land on the site, and buy — but SalesPilot has no way to know it was that email that drove the purchase. The commission goes unattributed.

The webhook question is the same — without it, Shopify doesn't tell SalesPilot when an order is placed, so even if the cookie is set, nothing gets recorded.

