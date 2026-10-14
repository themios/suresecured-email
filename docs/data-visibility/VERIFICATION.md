# Data visibility: fixes, verification and residual risk

PR: themios/suresecured-email#2 (branch `feat/data-visibility`, final commit `d3184af`)
Spec: `specs/2026-10-14-data-visibility.md` (High class, H0 approved 2026-10-14)
Mode: SW Engineering System used as advisory guidance only. Not adopted in this
repository (no `engineering.yml`). No enforcement control was installed.

## 1. The originating defect

| Field | Value |
|---|---|
| What failed | About 10,700 bot submissions accumulated in `platform_leads` from 2026-10-06. No screen showed that table and nothing watched its growth. The owner found it five days later by chance. |
| Class | SILENT_FAILURE (primary), TEST_GAP (secondary) |
| Severity | Severe. It delayed detection of a DESTRUCTIVE-class incident (CAPA-2026-10-10-form-relay). |
| Root cause | Features could create a store without any requirement that the owner can see it or be told when it changes. 10 of 46 tables had no screen. Nothing compared the schema with what is visible. |
| Why nothing caught it | Spec and review had no visibility criterion. No test enumerates tables. No runtime check watches inflow. |

## 2. Fixes shipped in the PR

| # | Fix | Control level | Prevents or detects |
|---|---|---|---|
| F1 | Data registry: every table has a plain name and either a screen, or counts only with a reason, or internal with a reason | Architecture | Prevents ghost tables |
| F2 | Real-database test: build an empty database with the app's own migrations, fail on any unregistered table or stale entry | Test, in CI | Prevents, before merge |
| F3 | Data health page: counts, 24h, 7d, newest, status per table, banner for unregistered tables. Counts only. | Detective (human) | Detects |
| F4 | Hourly anomaly check: alert when the last hour is over 50 and over 5x the 7-day hourly average. Alerts also cover unregistered, missing and unreadable tables. | Detective (automatic) | Detects within an hour |
| F5 | Form submissions view: masked email and phone, 50 per page, page cap 200, bounded filters, escaped text, no links | Architecture | Prevents bulk exposure |
| F6 | Reveal: one record, rolling 30 per 60 minutes, audit entry and limit written atomically before data is shown | Architecture plus detective | Prevents and leaves a trace |
| F7 | Operator-only access. Everyone else gets the app's ordinary 404. Fails closed on any doubt. | Architecture | Prevents |
| F8 | Data pages load no third-party resource. CSP forbids all script. | Architecture | Prevents |
| F9 | CI runs a Postgres service so database tests execute instead of skipping | CI | Detects, before merge |

## 3. Review findings and disposition

All findings ended FIXED with a test, and every fix was mutation checked (the fix was
reverted, the test went red, the fix was restored).

| Round | Finding | Sev | Class | Fix |
|---|---|---|---|---|
| 1 | Failed alert consumed its suppression slot, so a continuing spike stayed silent for 6 to 24 hours | P1 | SILENT_FAILURE | Release on failed delivery |
| 1 | Registered table missing from the database raised no alert | P1 | SILENT_FAILURE | `data-missing` alert |
| 1 | Reveal page loaded CDN JavaScript that could read the revealed values | P1 | PII | Self-contained page, script-free CSP |
| 1 | Reveal limit reset at the clock hour (60 in minutes) | P2 | PII | Rolling 60 minutes counted from the audit log, atomic |
| 1 | Impossible dates (2026-02-31) reached a SQL cast and failed the page | P2 | INPUT | Exact calendar round-trip |
| 2 | List page loaded CDN JavaScript that could press Reveal and read the answer | P1 | PII | Both pages script-free |
| 2 | Alert suppression used clock-aligned buckets, not an interval from the last alert | P2 | SILENT_FAILURE | Rolling alert gate |
| 3 | Gate rows set `alerted_at`, which the form abuse report reads as a tripped spam limit | P2 | SILENT_FAILURE | Gate leaves it NULL |
| own | Release matched nothing: JS Date milliseconds against database microseconds. Caught only by the real-database test. | P1 equivalent | SILENT_FAILURE | Claim time carried as text |

Final-commit review: Codex reacted with approval and raised no new findings. The thread
"Alert when a registered table is missing" still displays because GitHub re-anchors the
round 1 comment (created 07:26 on commit `6e75c94`). It was fixed in `35dc026`.

Pattern worth noting: five of nine defects were SILENT_FAILURE in the monitor itself.
A detective control has its own silent failure modes and needs its own tests.

## 4. Test evidence

| Evidence | Result |
|---|---|
| Route tests without a database (`src/routes/dataVisibility.test.js`) | 24 pass. Every acceptance criterion plus each finding. |
| Real-database tests (`src/test/dataRegistry.test.js`) on an empty Postgres 16 built by `initDb` | 7 pass. 46 of 46 tables registered, 40 parallel reveals admit exactly 30, 10 parallel alert claims admit 1. |
| Previously skipped estimate store tests | 5 pass. They had never run in CI before this PR. |
| Full suite, local with database | Pass, 0 failures, 0 skipped |
| CI (GitHub Actions with Postgres service) | Pass on `d3184af`. Logs show AC13 and AC14 executed, not skipped. |
| Mutation checks | 9: operator gate widened, masking removed, registry entry removed, alert release removed, CDN script in reveal, CDN script in pages, interval check removed, `alerted_at` set, and the original routine-alert grouping (PR on form alerts). Each turned a test red. |
| Browser check, local copy | Both pages rendered at desktop and phone width. The spike was flagged, scam HTML shown as text, links not clickable, masking held. One reveal produced one audit row. A customer owner received the same "Cannot GET" response as a nonexistent path. |
| Production | **Not yet verified.** Not merged or deployed. See residual risk R1. |

## 5. SW Engineering controls: applied and missing

Applied as guidance:

| Control | How it applied |
|---|---|
| Standard §3 risk classes | High (authorization, personal data, tenant isolation). Owner H0 before build. |
| Standard §4 route | S0 spec, S1 build, S2 PR, S3 CI, S4 to S6 Codex review with dispositions. S7 and S8 are pending the owner. |
| Standard §5 specs | Written from the repository, with out-of-scope listed |
| Standard §6 definition of done | Each AC mapped to an executing test. Browser check. Real database for database behaviour. Residual risk stated. |
| Standard §7 evidence | Production not claimed as verified. CI log checked for executed, not skipped, tests. |
| Standard §8 bounds and silent failure | Named limits. A count that could not be read shows "Unavailable", never 0. Failed alerts are reported. |
| Security baseline: access, people, input | Identity from the session. 404 instead of 403. No real names in code or tests. Bounded, type-checked filters. |
| Module multi-tenant | No per-organization breakdown. Tests for every non-operator role. |
| Module postgres rules 5 and 6 | Paginated reads. Check and audit write in one transaction. |
| Finding states and CAPA format | Every finding replied to with STATE, CLASS, ROOT CAUSE, CONTROL |

Missing (gaps found by this work):

| Gap | Evidence | Closest existing rule |
|---|---|---|
| G1. No rule that every persistent store is visible to its owner or carries a written reason | 10 of 46 tables had no view. The flood went unseen for five days. | §8 "A failure the user cannot see is a defect" covers failures, not data. |
| G2. No rule for inflow monitoring on stores fed by outside input | Detection came from a billing screen | §8 bounds cover spend, not inflow |
| G3. No rule on third-party executable resources on pages that show personal data | Codex P1 twice | None. The baseline is silent. |
| G4. No rule on alert semantics: suppression counts delivered alerts only, over a rolling interval | Four SILENT_FAILURE findings in the monitor | §8 silent failure, in spirit only |
| G5. A skipped database test is indistinguishable from a passing one | 5 estimate store tests skipped in CI since 2026-10-10 | §6.4 requires a real database but nothing fails on a skip |
| G6. No rule that a privileged role a feature depends on exists before release | Production has no operator account | §9 configuration before release, which names keys, not roles |

## 6. Residual risk

| # | Risk | Status |
|---|---|---|
| R1 | Not merged or deployed. Nothing in this record is verified in production. | Owner decision (H1) |
| R2 | No operator account in production. The pages are unreachable for everyone until one exists. This fails safe. | Owner action |
| R3 | The operator login sees everything and has no second factor | Next item proposed |
| R4 | A flood can run up to one hour before the hourly check alerts | Accepted in the spec |
| R5 | The rest of the app loads JavaScript from a CDN on pages that show customer personal data. This is the same defect as the two P1s, outside this PR's scope. | Escalated to the owner |
| R6 | "Likely spam" is a heuristic. It sorts and never hides or deletes. | Accepted |
| R7 | On a phone, the app's fixed sidebar squeezes other pages | App-wide, out of scope |
| R8 | `specs/` and the CI workflow change are SW Engineering artifacts added to a repository that has not adopted it (§11) | Owner decision: keep, move, or revert |

## 7. Lesson for validating SW-OBS-001

SW-OBS-001 is not yet written in the SW Engineering System repository. This lesson
states what any version of it must achieve, measured on this case. It is proposed for
owner review and has not been filed anywhere.

```
scope: global
defect_class: SILENT_FAILURE
severity: severe
control: test + architecture
projects: [suresecured-email]
verified: 2026-10-14  verified_from: themios/suresecured-email#2 @ d3184af
```

**Lesson.** A system that stores data nobody can see will fail silently on that data.
Every persistent store needs three things: a registry entry that says how its owner sees
it (or why it does not need to), a test that fails when the schema and the registry
disagree, and an inflow check that alerts on abnormal growth. The monitor must not fail
silently either: it must alert when it cannot read a store, and it must alert again if
an alert was not delivered.

**Validation test for SW-OBS-001.** Replay the 2026-10-06 flood, about 1,100 junk rows a
day into a table no screen shows. The control is valid only if all four hold:
1. Design-time: adding that table without a registry entry fails CI. Shown here by
   removing `commission_events` from the registry, which failed AC13 naming the table.
2. Run-time: the first hour over threshold produces one owner alert, and a delivery
   failure is retried the next hour. Shown by the AC9 and round 1 P1 tests.
3. Inspection: the owner can see counts within one click, and contents only through an
   access-controlled, audited view. Shown by AC1 to AC8.
4. Self-monitoring: a missing or unreadable store alerts. Shown by the round 1 P1 and
   AC11 tests.

Against the incident baseline (five days to detection by chance), the target is
detection within one hour without anyone looking.
