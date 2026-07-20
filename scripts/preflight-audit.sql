-- Pre-flight audit for the tenant-isolation work.
-- Read-only: every statement is a SELECT. Safe to run against production.
--
-- Run with:  railway connect Postgres -- -f scripts/preflight-audit.sql
-- or paste the whole file into an interactive psql session.

\echo ''
\echo '=== 1. Users with no tenant (these get a 403 on /settings after the fix) ==='
SELECT id, email, role, client_id, active
FROM users
WHERE client_id IS NULL
ORDER BY id;

\echo ''
\echo '=== 2. How many tenants actually exist ==='
SELECT id, name, slug, active FROM clients ORDER BY id;

\echo ''
\echo '=== 3. Orphaned rows: data with no tenant attached ==='
\echo '    Any nonzero count here goes INVISIBLE once queries are tenant-scoped.'
SELECT 'leads'             AS table_name, COUNT(*) FILTER (WHERE client_id IS NULL) AS orphaned, COUNT(*) AS total FROM leads
UNION ALL SELECT 'orders',            COUNT(*) FILTER (WHERE client_id IS NULL), COUNT(*) FROM orders
UNION ALL SELECT 'clicks',            COUNT(*) FILTER (WHERE client_id IS NULL), COUNT(*) FROM clicks
UNION ALL SELECT 'commissions',       COUNT(*) FILTER (WHERE client_id IS NULL), COUNT(*) FROM commissions
UNION ALL SELECT 'form_submissions',  COUNT(*) FILTER (WHERE client_id IS NULL), COUNT(*) FROM form_submissions
UNION ALL SELECT 'salespeople',       COUNT(*) FILTER (WHERE client_id IS NULL), COUNT(*) FROM salespeople
ORDER BY orphaned DESC;

\echo ''
\echo '=== 4. Which schema migrations are actually applied ==='
\echo '    (Resolves the missing-004 question. No schema_migrations table exists,'
\echo '     so we probe for the columns/tables each migration was supposed to add.)'
SELECT
  to_regclass('public.clients')              IS NOT NULL AS m001_tenancy,
  to_regclass('public.commission_events')    IS NOT NULL AS m002_commissions,
  to_regclass('public.suppression_list')     IS NOT NULL AS m003_deliverability,
  to_regclass('public.call_logs')            IS NOT NULL AS m006_voice,
  to_regclass('public.agent_events')         IS NOT NULL AS m009_agents,
  to_regclass('public.email_sources')        IS NOT NULL AS m012_sources,
  to_regclass('public.client_auth_domains')  IS NOT NULL AS m013_auth_domains;

\echo ''
\echo '=== 5. Tables present in the DB that no migration file creates ==='
\echo '    (A leftover from migration 004 would show up here.)'
SELECT tablename FROM pg_tables
WHERE schemaname = 'public'
ORDER BY tablename;

\echo ''
\echo '=== 6. Global unique indexes that block a second tenant (P0-8) ==='
SELECT indexname, indexdef FROM pg_indexes
WHERE schemaname = 'public'
  AND indexdef LIKE '%UNIQUE%'
  AND indexdef NOT LIKE '%client_id%'
ORDER BY tablename, indexname;

\echo ''
\echo '=== 7. Would the composite-index conversion fail? (expect 0 rows) ==='
SELECT phone, COUNT(*) AS dupes
FROM leads WHERE phone IS NOT NULL
GROUP BY phone HAVING COUNT(*) > 1;

\echo ''
\echo '=== 8. Sending state — confirm autoresponder really is off ==='
SELECT
  (SELECT COUNT(*) FROM contact_enrollments WHERE status = 'active') AS active_enrollments,
  (SELECT COUNT(*) FROM email_sends)                                  AS emails_ever_sent,
  (SELECT MAX(sent_at) FROM email_sends)                              AS last_send_at;

\echo ''
\echo '=== done ==='
