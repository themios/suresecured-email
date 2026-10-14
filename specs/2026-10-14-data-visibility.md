# Spec: data visibility (Data health, form submissions, no hidden tables)

Risk class: High (authorization, personal data, tenant isolation)
PR: to be opened
Owner request (2026-10-14): "I think it's important to add a view of all of these 10000
emails. Currently they are ghosts, and if I didn't ask you I would've never known. If I
had SaaS seats, this could happen to anyone." Authorized as a separate, bounded
workstream with two additions: "access controls for sensitive records and anomaly
alerting. The admin dashboard must never become an unrestricted database browser, and
aggregate monitoring must not expose one customer's records to another."

## Goal

No data the platform stores is invisible to its owner. A sudden change in any store is
reported without anyone having to look. Seeing data is limited to the people who may see
it, and every look at sensitive records leaves a trace.

## Background (from the repository)

- The schema has 46 tables. 10 are read by no screen. Four of those matter to the owner:
  `platform_leads` (website form), `audit_log`, `agent_runs`/`agent_events`,
  `commission_events`.
- `platform_leads` received about 10,700 bot submissions from 2026-10-06 and nobody could
  see them. Detection took five days and happened by chance.
- Roles today: `operator` (platform, sees every organization), `owner` and `admin`
  (organization level, handed out to customers), salespeople. Production has no
  `operator` account; the operator seed is dev only. The platform owner logs in as
  `owner`.

## Users and behaviour

Platform operator (role `operator`) only:

1. **Data health** page under Admin. One row per registered table: plain name, total
   records, added in the last 24 hours, added in the last 7 days, newest record time, and
   a status of Normal, Spike or Unavailable. Counts only, never record contents. A banner
   lists any table that exists in the database but is not registered.
2. **Website form submissions** page under Admin. 50 records per page, newest first, with
   date, business name, contact name, trade, message, whether a confirmation email was
   sent, whether the person confirmed, and a spam flag. Email and phone are masked
   (`j•••@gmail.com`, `•••• 1234`). Filters: date range, confirmed or not, spam or not.
3. **Reveal** button per record shows that one record's full email and phone. Each
   reveal is written to the audit log.
4. **Anomaly alert** on Telegram when a table grows far faster than normal or a table
   appears that is not registered.

Everyone else (owner, admin, salesperson, logged out): the pages and the reveal action
do not exist for them. They get "not found".

## Business rules

- **Not a database browser.** Pages read only tables named in a fixed registry in code.
  No table name, column name or query text ever comes from the request. The form
  submissions page reads one table, `platform_leads`.
- **Read only.** Neither page can edit or delete. The spam cleanup stays a separate,
  approved operation.
- **Operator only.** Both pages and the reveal action require role `operator`. Every other
  caller gets 404, so the pages' existence is not disclosed.
- **No cross-customer exposure.** The Data health page shows platform-wide totals and is
  operator only. It has no per-organization breakdown in this change. Anomaly alerts carry
  table names and counts only, never record contents, organization names or addresses.
- **Masked by default.** Email and phone are masked on the page. Full values only through
  Reveal, one record at a time.
- **Every look leaves a trace.** Audit log entries: `data_health.view`,
  `form_submissions.view` (page number and filters, no record contents),
  `form_submissions.reveal` (record id). Actor taken from the session.
- **Bounded.** Named constants: page size 50, highest page 200, at most 30 reveals per
  operator per hour, each count query cut off after 5 seconds.
- **Stranger input is displayed as text.** Every field is escaped. Links in messages are
  shown as plain text, never clickable (the spam carries scam links).
- **Anomaly rule.** Hourly check per registered table that has a creation time. Alert when
  the last hour's new records exceed both 50 and five times the average hour of the
  previous 7 days. At most one alert per table per 6 hours. Daily alert if any table is
  unregistered. A failed check alerts at most once an hour. It is never silent.
- **No hidden tables.** Every table in the schema has a registry entry: a screen, or
  counts only with a written reason, or internal with a written reason. A test fails when
  a table has no entry or an entry names a table that does not exist.

## Acceptance criteria

1. Given an operator, when they open Data health, then every registered table shows its
   totals and status, and an unregistered table appears in the banner.
2. Given an owner, admin, salesperson or logged-out visitor, when they request Data
   health, the form submissions page or Reveal, then they get 404 and no audit entry
   claims they viewed data.
3. Given an owner of organization A, when they request either page with any query
   string, then they get 404 (no parameter grants access).
4. Given a request with an extra parameter naming another table or column, when the
   page loads, then the parameter is ignored and only registered data is shown.
5. Given an operator on the form submissions page, then emails and phones are masked,
   page size is 50, and a page beyond 200 is refused.
6. Given a submission whose message contains HTML and a URL, when shown, then the HTML is
   escaped text and the URL is not a link.
7. Given an operator, when they press Reveal, then that one record's email and phone are
   shown and one `form_submissions.reveal` audit entry with that record id is written.
   The 31st reveal in an hour is refused.
8. Given an operator, when they view either page, then one view entry is written to the
   audit log with no record contents.
9. Given a table whose last hour exceeds both thresholds, when the hourly check runs,
   then one Telegram alert names the table and the counts. A second run in the same 6
   hours sends nothing.
10. Given normal traffic below the thresholds, then no alert is sent.
11. Given the check cannot reach the database or Telegram, then the failure is logged and
    an alert is attempted at most once an hour. The cron endpoint reports failure.
12. Given a count query fails, then the page shows "Unavailable" for that table, never 0.
13. Given a new table in the schema with no registry entry, when tests run, then the
    registry test fails and names the table.
14. Given the CI pipeline, then the registry test and the existing database tests run
    against a real Postgres built by the app's own migrations.

## Edge cases and failure

- Empty tables show 0 with status Normal. 0 is shown only when the count really ran.
- A table without a creation time shows totals only, and has no anomaly check.
- Reveal on a record that does not exist returns 404.
- Telegram not configured: alerts are logged as not delivered and the cron endpoint
  returns an error.

## Out of scope

- Views for customers (owner, admin) of their own organization's data health.
- Detail views for `audit_log`, agent tables or `commission_events` (counts only here).
- Editing, deleting, exporting or downloading from these pages.
- The spam cleanup itself.
- Per-organization breakdowns.
- Two-factor login for the operator account.

## Security and data

- **Data touched, and whose:** reads row counts across all tables (no contents) and the
  contents of `platform_leads` (strangers who used the public form). Writes only
  `audit_log` entries and quota counters. No schema migration.
- **Who may trigger it, and how that is checked:** role `operator` from the session,
  checked before anything else in each route. The hourly check runs on the existing
  authenticated cron mechanism.
- **What is irreversible, and the rollback:** nothing. Rollback is redeploying the
  previous version. Audit entries stay, which is intended.
- **Configuration that must exist before release:** an `operator` account for the
  platform owner. Without it the pages are unreachable for everyone, which fails safe.

## Written from

`src/db.js`, `migrations/*.sql`, `src/routes/admin.js` (requirePlatformAdmin,
client-health), `src/middleware/apiAuth.js`, `src/middleware/auth.js`,
`src/routes/auth.js` (operator seed), `src/routes/cron.js` (form-abuse-report),
`src/index.js` (cron schedule), `src/lib/estimateStore.js` (consumeQuota),
`.github/workflows/test.yml`, and a table to screen map built by searching
`src/routes` for each table.
