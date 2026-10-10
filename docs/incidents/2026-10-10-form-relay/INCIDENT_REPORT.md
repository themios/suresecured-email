# Incident 2026-10-10: public estimate form abused as an email relay

Status: contained in code on a branch, NOT deployed. Production is still exposed.
Class: DESTRUCTIVE (outbound action with an unverified recipient), severe tier.

## Affected system

| Item | Value |
|---|---|
| Product | SalesWyze (the SalesPilot AI email app). Not DealerWyze. |
| Repository | github.com/themios/suresecured-email (local: Suresecured/Email_Suresecured) |
| Deployment | Railway project Email-Campaign, service suresecured-email, production, saleswyze.com |
| Deployed commit | 65b348db (master) |
| Endpoint | POST /get-started (landing page "free estimate" form) |
| Model account | OpenRouter key shared by every AI feature in the app |

## What happened

The form is public. On every submission the server saved the lead, called a language
model to write an intro paragraph, rendered the estimate, and emailed a copy to the
address typed into the form. A bot found it and has submitted it about 100 times an hour
since 2026-10-06, each time with a different harvested email address and scam text in the
business name field.

## Timeline (UTC)

| When | Event | Source |
|---|---|---|
| 2026-07-30 | First row in the leads table (owner test) | database |
| 2026-08-03 07:09 | Last time the tenant mail login is recorded as working | client_email_config |
| 2026-08-03 to 2026-10-05 | Low-rate form spam, one row every 1 to 3 days (promo and jackpot text, gibberish). Nobody noticed. | database |
| 2026-10-05 09:50 | First Russian-language prize scam rows | database |
| 2026-10-06 01:47 | First row inside the flood window. Flood proper from about 11:46. | database |
| 2026-10-06 to 10-10 | 1,145 / 3,224 / 2,490 / 2,087 / 1,763 rows per day (10-10 partial, to 22:22) | database |
| 2026-10-10 afternoon (owner local time) | Owner sees a steady stream of small calls in the OpenRouter activity list and asks what is happening | owner report |
| 2026-10-10 22:20 | Evidence preserved, root cause confirmed | this investigation |

Detection was by the owner reading a billing screen. No alert exists for this form.

## Facts

- **Volume.** 10,733 rows in total. 10,709 arrived on or after 2026-10-06. 9,911 distinct
  addresses in the high confidence group, 96% gmail.com or icloud.com.
- **Sources.** The retained HTTP log (2026-10-09 20:00 to 10-10 22:18) shows 2,188 POSTs
  from 46 source IPs, about 250 each, about 10 an hour per IP. The per-IP limit is 10 per
  15 minutes, so no request was ever refused (zero 429 responses). The same Windows Chrome
  user agent string appears on every request.
- **Model spend.** The key reports lifetime use of $13.81, a $6 limit with $1.08 left,
  $3.11 in the last 7 days and $4.92 in the last 30. At the observed cost of about
  $0.00016 per call, 10,709 submissions account for roughly $1.70 if every one reached the
  model. At the current rate the remaining $1.08 lasts about 3.5 days. The same key serves
  reply classification and the marketing agents, so exhausting it degrades real features.
  In OpenRouter's log the calls appear as "SalesPilot Digest" because that label was shared
  by three features. The daily digest itself ran correctly once a day.
- **Delivery.** No evidence that any estimate email was delivered. In the retained
  application log (2026-10-10 02:05 to 22:12) every one of 1,536 send attempts failed with
  "535 Authentication credentials invalid" on the tenant SMTP login. The platform sender
  is configured to use that login first, so the Gmail fallback was never reached. This
  is NOT proven for 2026-10-06 to 2026-10-09 because Railway retains only the most
  recent log lines. To close it, check the Sent folder and bounce mail of the tenant
  mailbox on suresecured.com for those dates. I cannot see that mailbox.
- **Why the failure was invisible.** The estimate email path does not update the mail
  health counters. The tenant record still shows zero consecutive failures and no error.
- **Not a real prospect problem.** Of 10,733 rows, one is the owner's test and one is an
  unclear vendor pitch. The rest read as spam, including 22 before the flood. The form
  may never have produced a genuine lead.

## Root cause

A public, unauthenticated endpoint performed two actions that cost money or reach a
third party (model call, email) immediately on input, and took the email recipient from
that same input without proving the submitter owns it. The only controls were a hidden
form field and an in-memory per-IP counter. A bot that leaves the hidden field empty and
spreads its requests over 46 addresses passes both. Nothing bounded the total, so the
only ceiling was the model key's own spending limit.

Contributing causes:

1. No daily or global quota on model calls or outbound email (control missing).
2. No output size cap on the model call.
3. The mail login had been broken for an unknown time with no alert (masked the harm and
   would have turned it into a spam campaign the day someone fixed the login).
4. Model spend shared one label, so the log could not say which feature was spending.
5. No monitoring of the form (submissions per hour, confirmation rate).
6. The project has not adopted the engineering standard (no engineering.yml), so the
   email and AI module rules were not applied to it.

## Evidence (outside the repository because it holds third-party addresses)

Directory: /home/tim/incident-evidence/2026-10-10-form-relay (mode 700, files 600)

| File | Content |
|---|---|
| platform_leads.json | all 10,733 lead rows as of 2026-10-10 22:23 |
| railway_http_2026-10-09_to_10-10.jsonl | 5,000 HTTP log lines with source IP |
| railway_app_logs_2026-10-10.jsonl | 3,000 application log lines |
| classification_v2.json | row id to cleanup bucket |
| SHA256SUMS | hashes taken at collection |

Railway keeps only recent logs. The copies above are the only record of 2026-10-09
20:00 onward. Copy them somewhere durable if this incident is escalated.

## Containment status

| Step | State |
|---|---|
| Code that stops model calls and email from unverified submissions | written, tested, committed on branch `incident/2026-10-10-form-relay-containment` (3f299b0) |
| Deployed to production | NO. Needs approval (Hold A). |
| Records deleted | NO |
| Credentials changed | NO |
| External email sent | NO |

Until Hold A is approved and deployed, each submission still causes one model call. The
email attempts fail on the broken login. The loss rate is about $0.30 a day plus the
risk that someone repairs the mail login.
