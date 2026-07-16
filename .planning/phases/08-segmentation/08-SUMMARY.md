---
phase: 08-segmentation
plan: SUMMARY
subsystem: agents
tags: [multi-tenant, segmentation, scoring, event-bus]
status: deployed
commit: b675b9e
completed: 2026-07-16

requires:
  - phase: 07-agent-foundation (runner, event bus)
  - phase: 05-ai-intelligence (engagement_score via lib/scoring)
provides:
  - Segmentation agent — hot/warm/cool/cold tiering on leads.engagement_score
  - leads.segment + segmented_at; segment.updated event
affects: [09-email-agent, 10-research-planning, reporting]

key-files:
  created:
    - migrations/010_lead_segment.sql
    - src/lib/agents/segmentation.js
  modified:
    - src/db.js (register migration 010)
    - src/lib/agents/scheduler.js (dispatch + order)
    - src/lib/agents/agents.test.js
    - src/routes/settings.js (Segmentation live)
---

# Phase 08 — Segmentation: Summary

Deterministic, zero-LLM-cost tiering. A single SQL pass assigns each lead a tier
(configurable numeric thresholds, validated) and updates only rows whose tier
changed (`RETURNING` gives the moved count), emitting `segment.updated` only when
something moved — keeping the event bus quiet. Read/label only; no sends.

**Verified:** unit tests (segmentForScore/resolveThresholds incl. null→cold and
custom thresholds) + local integration (correct distribution, event-on-change-
only, idempotency, re-bucketing on score change). Deployed; runs before Reporting
so the weekly rollup sees the event same run.
