# Hold A: stop unverified submissions from triggering AI and email

Branch: `incident/2026-10-10-form-relay-containment`, commit 3f299b0. Class: High
(production change that removes an outbound action).

**What changes.** After saving the lead, the form shows the plain thank-you page. The
model call, the estimate page and the estimate email are not reachable from the form.
One route, 14 lines removed. No schema change.

**Why we need it.** The form is being used at about 100 submissions an hour. Each causes a
paid model call, and the email step only fails because the mail login is broken.

**What could go wrong.**
- Real prospects stop getting an instant estimate. Evidence says there may be none: one
  owner test and one unclear pitch out of 10,733 rows.
- Junk rows keep arriving (about 100 an hour, a few megabytes a week). Real leads stay
  mixed in until cleanup.

**What protects against that.** The rows are still saved, so no lead is lost (prevents
loss). A test fails if a model call or email can be triggered by a submission (detects a
regression before deploy). I broke the code on purpose and the test went red.

**What users will experience.** After sending the form: "Got it. We'll look at what you
sent and get back to you shortly." No estimate page, no email.

**Rollback.** Revert one commit or redeploy the previous Railway deployment. Minutes.

**Recommendation: APPROVE.** It removes the cost and the relay risk with the smallest
possible change and loses nothing that was working.

Reply: `HOLD A: APPROVED` / `HOLD A: REJECTED <why>`

---

# Hold B: verified-recipient workflow (replaces Hold A)

Branch: `incident/2026-10-10-form-relay-remediation` (built on Hold A). Class: High
(schema migration, outbound email).

**What changes.** A submission saves the lead and sends ONE fixed-text email asking the
person to confirm. Only after they open the link and press Confirm (single-use, 24 hours)
does the server write the estimate, call the model and send the estimate email. Caps:
5 confirmation emails a day per source IP, 2 per inbox (Gmail dots and plus tags counted
as one), 100 a day for the whole site, 100 model calls a day, 300 stored leads an hour.
Migration 026 adds three columns and two tables. A daily report posts the numbers to
Telegram and flags the incident pattern.

**Why we need it.** It restores the estimate feature without letting a stranger make the
platform email an address they do not own.

**What could go wrong.**
- The confirmation email cannot go out until the tenant mail login is fixed. Until then
  every submission is saved, marked "failed", and an alert fires (once an hour). Visitors
  see "check your email" and nothing arrives.
- A flood can use up the 100 emails a day and block a real visitor that day. The lead is
  still saved. This trades a rare missed email for a hard ceiling on abuse.
- The confirmation email still goes to an unverified address, up to 100 a day. Its text is
  fixed and contains nothing the submitter typed, so the worst case is 100 bland messages
  a day, down from unlimited.
- Link scanners in mail systems open links. The link only shows a button, so a scanner
  cannot confirm on the person's behalf.

**What protects against that.** Prevents: proof of inbox ownership, single-use hashed
tokens, fixed link origin (not the Host header), strict input bounds, caps counted in the
database so they survive restarts. Detects: failed-send status per lead, alert on first
quota trip, daily abuse report. Verified with 25 tests (no database), 5 tests against a
real Postgres (50 parallel requests admit exactly the limit, 20 parallel uses of one token
succeed exactly once), a full migration run on an empty database, and 3 deliberate
regressions that each turned a test red.

**What users will experience.** Form, then "Check your email". Email, then a page with one
button, then the estimate.

**Rollback.** Redeploy the previous deployment. Migration 026 only adds columns and
tables, so the old code ignores them. Nothing to undo.

**Conditions before deploy.** (1) Set `PLATFORM_SALESPERSON_ID` in Railway to the salesperson whose identity platform mail should use. There is deliberately no fallback, so without it no confirmation email is sent (leads are saved, status "failed", alert fires). This is a configuration change that needs your approval. (2) Repair and test the tenant mail login first, or accept that no
confirmation emails go out. Do the repair AFTER Hold B is live, never before Hold A or B.

**Recommendation: APPROVE after Hold A is live and Codex has reviewed the branch.** The
branch has not been through independent review yet.

Reply: `HOLD B: APPROVED` / `HOLD B: REJECTED <why>` / `HOLD B: APPROVED WITH CONDITION <condition>`
