---
phase: 01-foundation
plan: 01
subsystem: database
tags: [postgres, migration, multi-tenant, jsonb, indexing]

# Dependency graph
requires: []
provides:
  - organizations table (id, name, slug, created_at)
  - clients table (id, organization_id, name, slug, brand_config JSONB, commission_rules JSONB, integration_settings JSONB)
  - users table (id, organization_id, client_id, email, password_hash, role CHECK enum)
  - client_id FK column on all 17 existing tables
  - Partial index idx_contact_enrollments_active_next for cron scale
  - SureSecured org + client seeded with brand_config JSONB
  - initDb() wired to run migration before existing CREATE TABLE statements
affects:
  - 01-02 (auth) — uses users table and client_id scoping
  - 01-03 (client UI) — reads/writes clients table
  - 01-04 (branding) — reads clients.brand_config JSONB
  - 01-05 (cron) — uses partial index for scale

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Idempotent DDL migrations using IF NOT EXISTS and DO $$ EXECUTE blocks"
    - "JSONB columns for config blobs to avoid future schema migrations"
    - "Partial indexes for query-specific performance (WHERE status = 'active')"

key-files:
  created:
    - migrations/001_add_tenancy.sql
  modified:
    - src/db.js

key-decisions:
  - "DO $$ EXECUTE block used for iterating tables to add client_id — avoids 17 separate ALTER TABLE statements and stays idempotent"
  - "users table created fresh alongside admin_users (not replacing it yet) — 01-02 will handle auth unification"
  - "client_id added as nullable FK initially — backfill and NOT NULL enforcement deferred to application layer"

patterns-established:
  - "Migration pattern: SQL file in migrations/ run by initDb() before existing CREATE TABLE statements"
  - "Seed pattern: INSERT ... ON CONFLICT (slug) DO NOTHING for idempotent seed data"

# Metrics
duration: 15min
completed: 2026-06-30
---

# Phase 01 Plan 01: Database Migration Summary

**Multi-tenant schema added to 17-table single-tenant DB via idempotent SQL migration wired into initDb() — organizations, clients, users tables created; client_id FK added to all existing tables; partial cron index and SureSecured seed data included**

## Performance

- **Duration:** ~15 min
- **Started:** 2026-06-30T18:13:42Z
- **Completed:** 2026-06-30T18:28:00Z
- **Tasks:** 2
- **Files modified:** 2

## Accomplishments

- Created `migrations/001_add_tenancy.sql` with fully idempotent DDL for all schema changes
- Extended `initDb()` in `src/db.js` to run the migration file before existing table creation
- Three new tables (organizations, clients, users) with proper FK relationships and role CHECK constraint
- client_id FK column added to all 17 existing tables via single DO $$ loop (idempotent)
- Partial index `idx_contact_enrollments_active_next` created for cron query performance at 500k rows
- SureSecured org + client seeded with full brand_config JSONB (colors, phone, website, address, CTA)

## Task Commits

Each task was committed atomically:

1. **Task 1: Create migrations/001_add_tenancy.sql** - `7bbdfc5` (feat)
2. **Task 2: Wire migration into src/db.js initDb()** - `243ee82` (feat)

## Files Created/Modified

- `migrations/001_add_tenancy.sql` — Idempotent DDL: 3 new tables, client_id FK loop on 17 tables, partial index, seed data
- `src/db.js` — Added `fs`/`path` requires; initDb() now reads and runs migration SQL before existing statements

## Decisions Made

- Used a DO $$ FOREACH loop to add client_id to all 17 tables — more maintainable than 17 separate ALTER TABLE statements and stays idempotent via information_schema check
- Left admin_users table in place — 01-02 plan will unify auth into the new users table; co-existence is safe
- client_id nullable initially — avoids breaking existing NULL rows; application layer enforces scoping before a backfill pass makes it NOT NULL

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

**DATABASE_URL is a placeholder in .env** — CommissionTracker is a new project where the actual Railway PostgreSQL URL has not been provisioned yet. The migration SQL and db.js wiring are complete and correct; they will execute on first `npm start` once DATABASE_URL is set to the real Railway connection string.

The plan's verification step (`psql $DATABASE_URL -f ...`) could not be run locally. Node syntax check (`node --check src/db.js`) passed cleanly. Migration SQL was reviewed for correctness.

## User Setup Required

Before the migration can run, set the real DATABASE_URL in `.env`:

```
DATABASE_URL=postgresql://<user>:<password>@<railway-host>:5432/<dbname>
```

Then run:
```bash
node -e "const {initDb}=require('./src/db'); initDb().then(()=>{console.log('OK');process.exit(0)}).catch(e=>{console.error(e);process.exit(1)})"
```

Expected output: `OK` with no errors. Confirm with:
```bash
psql $DATABASE_URL -c "\dt organizations clients users"
psql $DATABASE_URL -c "SELECT indexname FROM pg_indexes WHERE indexname='idx_contact_enrollments_active_next'"
psql $DATABASE_URL -c "SELECT id, slug FROM organizations; SELECT id, slug FROM clients"
```

## Next Phase Readiness

- 01-02 (auth): users table with role enum is ready; can build JWT auth middleware against it
- 01-03 (client UI): clients table with brand_config JSONB is ready; can build CRUD routes
- 01-04 (branding): clients.brand_config schema matches what buildHtml() needs
- 01-05 (cron): partial index is defined; cron query will use it once DB is provisioned

Blocker: Railway PostgreSQL URL must be provisioned before any plan can verify against a live DB.

---
*Phase: 01-foundation*
*Completed: 2026-06-30*
