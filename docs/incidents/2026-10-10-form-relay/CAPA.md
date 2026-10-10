# CAPA-2026-10-10-form-relay

Project: suresecured-email (SalesWyze). Not adopted into the engineering standard
(no engineering.yml). Format follows `standard/CAPA.md`. Status: DRAFT, controls built on
branch, not deployed.

## Classification

Primary class: **DESTRUCTIVE** (outbound action to an unverified recipient). Severe tier,
so control analysis runs at the first occurrence.
Secondary classes: AI_OUTPUT (no cost bound on the model call), SILENT_FAILURE (mail login
broken with no alert), INPUT (array-valued fields reached string methods and would have
thrown), TEST_GAP (no test touched the public form), CONFIG (near miss, see below).

## 1. What failed, in plain consequences

A stranger could make the platform send mail to any address and spend model money, with
no limit except the model key's own cap. About 10,700 submissions in five days. Model
spend is small (about $1.70) but the risk is large: the first time someone repairs the
mail login, the platform sends thousands of scam-text emails from the company domain.

## 2. Root cause

The design treated "a form was submitted" as permission to act. The recipient came from
the same untrusted input as the request, and the actions (paid call, outbound mail) had
no budget. A manufacturing parallel: a machine that starts a costly cycle for any part
dropped into the hopper, with the only guard being a sensor a bot can trivially satisfy.

## 3. Why nothing caught it

| Stage | Why it did not |
|---|---|
| Spec and design | The estimate form was written as a marketing feature. No risk class was set, so the outbound-email rule for High class (ENGINEERING_STANDARD §3) never applied. |
| Tests | No test covered the route. |
| Review | No independent review of the form (the standard was not adopted here). |
| Runtime controls | Honeypot and a per-IP counter held in memory. Both pass with rotated IPs. |
| Detection | No monitoring, no alert. The model log labelled the calls "Digest". The mail login had been failing with no alert, which hid the outbound effect. |
| Owner | Detected by the owner reading the billing page, five days after the flood began. |

## 4. Controls, by level (ENGINEERING_STANDARD §2)

| # | Control | Level | Prevents or detects | Why this level |
|---|---|---|---|---|
| C1 | Estimate, model call and estimate email only after a single-use token sent to the address is used | Architecture | Prevents | Makes the harmful path impossible without inbox access. The strongest level that is practical. |
| C2 | Confirmation email is fixed text with no submitter content, fixed link origin | Architecture | Prevents | Removes the relay payload and the Host header trick. |
| C3 | Caps counted in the database: per IP, per inbox, global, model calls, stored leads | Architecture | Prevents | Bounds the worst case when C1 is cheap to pass (the attacker needs only a real inbox). Survives restarts and multiple instances. |
| C4 | Hashed tokens, GET shows a button, POST consumes | Architecture | Prevents | Stops database reads yielding links and link scanners confirming for people. |
| C5 | Strict input bounds, model output capped at 200 tokens | Architecture | Prevents | Closes the array and length cases. |
| C6 | Alert on first quota trip, alert on failed confirmation send, per-lead send status | Detective | Detects | Prevention cannot cover a broken mail login. This makes it visible within the hour. |
| C7 | Daily abuse report with the incident signature (many submissions, few confirmations) | Detective | Detects | Catches a slow attack that stays under the caps. |
| C8 | Per-feature model labels | Detective | Detects | The log can now say which feature spends. |
| C9 | 24 regression tests, 5 database tests, migration registration test | Test | Detects before deploy | See the effectiveness section. |

Rejected as primary controls: CAPTCHA (the captured spam includes adverts for CAPTCHA
solving software, so bots are already solving them), Cyrillic or keyword filters (the
attacker changes language), and a tighter IP limit (46 IPs at 10 an hour each).

Accepted tradeoffs and residual risk:
- Up to 100 fixed-text confirmation emails a day can still reach unverified inboxes. This
  is the cost of letting real visitors request a confirmation at all.
- A flood can use the daily cap and delay a real visitor's confirmation. Their lead is
  still saved. Availability is traded for a hard ceiling.
- The token is in the URL path of an emailed link. It is single-use, expires in 24 hours
  and is hashed at rest. It can appear in the host's request log until used.
- The stored-lead cap is 300 an hour, so a flood above it is not stored at all.

## 5. Near miss found during verification

The migration runner uses an explicit list of files. A new migration that is not added to
the list never runs, and every form submission would have failed in production. The empty
database boot test caught it. Control: a test that fails when a migration file is not
registered (src/test/migrationList.test.js). Class CONFIG.

## 6. Scope and outcome per CAPA.md

| Lesson | Outcome |
|---|---|
| Public forms must not trigger paid or outbound actions from unverified input | **technology knowledge**: proposed new module `public-forms` (below). Needs owner approval (hold H2). |
| Every model call has quota, output cap and its own label | already in `modules/ai-generation.md` rule 2. Not applied to this project. Adopt the standard here (outcome: project knowledge). |
| A recipient comes from proof, not input | proposed addition to `modules/email.md` (rule 6). H2. |
| Migration registration | **test** (done) |
| Mail health must include every send path | **project knowledge**: fixed here by recording status per lead. |

Proposed text for `modules/public-forms.md` (draft for owner decision, not installed):

1. A public route that can cause a paid call or an outbound message to an address taken
   from the request must prove control of that address first, with a single-use token.
2. Until proven, the only permitted outbound message is fixed text with no request content.
3. Every such route has caps per source, per recipient and global, counted in shared
   storage, each a named constant, with an alert on the first trip.
4. A route that sends mail records the outcome per request, and a failure alerts.
5. Rate limits held in process memory are not a security boundary.
Checks a project should have: a test that an unverified request cannot reach the model or
the mailer, and a test that each cap holds under distributed requests.

Also proposed to `~/Vault/inbox/lessons/` as a cross-project lesson (scope: global,
control: architecture). The Hellenic Tales and DealerWyze forms should be checked for the
same pattern (a one-hour task each).

## 7. Effectiveness checks

| Check | Pass condition | When | Evidence |
|---|---|---|---|
| E1 | Model calls labelled "SalesWyze Estimate" in OpenRouter never exceed the number of verified confirmations | 7 days after Hold B | OpenRouter activity vs `verify_status = 'verified'` count |
| E2 | Daily report shows zero SUSPECTED ABUSE flags, or each flag has a recorded cause | daily for 14 days | form-abuse-report log |
| E3 | Confirmation emails sent per day stay under 100 and quota trips are explained | 14 days | form_quota rows with alerted_at |
| E4 | Zero confirmation failures after the mail login is repaired | 1 day after repair | confirm_email_status counts |
| E5 | No recurrence of class DESTRUCTIVE on a public form in any project | 90 days | scorecard |
| E6 | The same pattern audited in the other public forms of the portfolio | 14 days | audit note per project |

A recurrence after Hold B means the control is at the wrong level or covers the wrong
path, which reopens this analysis (standard/CAPA.md, Effectiveness).

## Open items

1. Repair the tenant mail login (separate hold, credentials, after Hold B).
2. Confirm whether any estimate email was delivered 2026-10-06 to 10-09.
3. Cleanup of 10,731 spam rows (owner approval).
4. Codex review of the remediation branch (S4).
5. Decide whether to adopt the standard in this project (engineering.yml).

## Review log

| Date | Reviewer | Finding | Class | Disposition |
|---|---|---|---|---|
| 2026-10-10 | Codex, PR 1 | P1: the email check accepted display-name syntax, so one inbox could be reached under many quota keys and the per-inbox cap bypassed | INPUT | Fixed: one bare addr-spec only, and the counted address is the mailed address. Test added, mutation checked. |
| 2026-10-10 | Codex, PR 1 | P2: the token was consumed before the estimate was built, so a mid-way failure stranded a verified visitor | DATA_INTEGRITY | Fixed: claim with a 2 minute lease, complete after success, release on failure. Test added, mutation checked, real Postgres test added. |

Lesson for the public-forms draft: validate to ONE canonical value, then count, store and
deliver that same value. Counting one string and mailing another is a bypass.
| 2026-10-10 | Codex, PR 1 (round 2) | P2: an expired claim could repeat the model call for one token | AI_OUTPUT | Fixed: narrative persisted before rendering and reused on retry, claim fenced by a nonce so a stale request cannot complete or email. Residual: a crash between the model call and the save can repeat one call, bounded by the lease and the daily cap. |
| 2026-10-10 | Codex, PR 1 (round 2) | P1: sender fell back to the lowest enabled mailbox with no ownership check, so form traffic could send through a customer identity | AUTHZ | Fixed: `PLATFORM_SALESPERSON_ID` is required, validated as an active salesperson, no fallback. Fail closed, recorded and alerted. |
| 2026-10-10 | Codex, PR 1 (round 2) | P2: a failure to record a successful send was reported as a mail failure | SILENT_FAILURE | Fixed: delivery and status recording are separate steps. |
| 2026-10-10 | Codex, PR 1 (round 2) | P2: the alert helper resolved on Telegram errors, so a control could fail silently | SILENT_FAILURE | Fixed: strict helper rejects on transport and non-2xx, failures are logged, the daily report returns 502 if its alert did not arrive. |

Second lesson for the public-forms draft: never infer which identity sends platform mail
from ordering. Name it explicitly and fail closed.
| 2026-10-10 | Codex, PR 1 (round 3) | P1: the SMTP/SES fallback ignores `sendAs`, so platform mail had no From address and would fail wherever Gmail is not connected | INTEGRATION | Fixed: both platform emails pass an explicit From address. Test added, mutation checked. |
