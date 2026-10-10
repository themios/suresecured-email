# Cleanup report: suspected spam records (nothing deleted)

Source: platform_leads as of 2026-10-10 22:23 UTC, 10,733 rows. Row ids per bucket are in
`/home/tim/incident-evidence/2026-10-10-form-relay/classification_v2.json`. This report
holds counts only, no addresses.

## Criteria

No row has ever been verified, because verification did not exist. So "unverified" does
not separate anything. Rows are bucketed by independent signals read from the row itself.
No single signal (Cyrillic text included) decides a bucket.

| Signal | Test |
|---|---|
| S1 | business name contains Cyrillic letters |
| S2 | message contains Cyrillic letters |
| S3 | message is 3 to 8 short tokens of random mixed-case letters and digits |
| Window | created on or after 2026-10-06 00:00 UTC |

## Buckets

| Bucket | Rule | Rows | Recommended action |
|---|---|---|---|
| A, high confidence | in window and two or more signals | 9,929 | archive, then delete |
| B, one signal | in window and exactly one signal | 755 | archive, then delete after a 20-row sample check |
| C, no signal, same campaigns | in window, no signal, reads as spam: 22 captcha-solver adverts, 2 promo-text rows, 1 gibberish | 25 | archive, then delete |
| D, before window | created 2026-07-30 to 2026-10-05 | 24 | owner review, see below |
| Total | | 10,733 | |

Bucket A: 9,911 distinct addresses (9,501 gmail.com, 405 icloud.com, 9 one other domain).
Daily counts for A to C: 10-06 1,145, 10-07 3,224, 10-08 2,490, 10-09 2,087, 10-10 1,763.

Bucket D by content (read by me, not by a filter):
- 1 row is the owner's own test (id 1). Keep.
- 1 row is an unclear outside pitch (id 2). Owner decides.
- 22 rows (ids 3 to 24) are spam campaigns: promo and jackpot text, gibberish, and four
  Russian prize rows. Same actors as the flood or earlier visitors of the same kind.

Result: of 10,733 rows, 1 is known real, 1 is undecided, 10,731 look like spam.

## Method limits

- The signals are heuristics. Buckets B and C were checked by reading, A was sampled.
  A spam row without Cyrillic or random tokens in the flood window falls in C and was
  read individually (25 rows). A real prospect who happened to write Cyrillic would land
  in A or B. That is why the action is archive first.
- Before deleting, the owner should read 20 random rows from B and all of D.

## Proposed procedure (NOT executed, needs approval)

1. Create `platform_leads_archive` as a copy of the table and copy the chosen ids into it.
2. Verify the archive row count equals the id list count.
3. Delete from `platform_leads` by id list, in one transaction, inside the same window.
4. Keep the archive 90 days, then drop it.

Rollback: re-insert from the archive. Irreversible only after step 4.
Run it after Hold A or B is live, otherwise new junk arrives while cleaning.
