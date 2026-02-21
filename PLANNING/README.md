# BrainSurgeon Planning

This directory contains the current project planning documents.

## Current Plan

**EXECPLAN.md** — The single source of truth for remaining work. This consolidates all previous plans into one document covering:
- TypeScript API status (COMPLETE)
- Smart Pruning system (COMPLETE)
- Extension restoration (IN PROGRESS — critical path)
- Optional extraction system improvements

## Historical Context

The following legacy planning documents were consolidated into EXECPLAN.md and moved to `.trash/`:

- `PLAN.md` — Original feature parity plan (Phase 1-5)
- `PLAN-PHASE3-4.md` — Smart pruning configuration features
- `PLAN-PHASE3-FINAL.md` — Detailed smart pruning specification  
- `EXECPLAN.md` (old) — Extension restoration attempt (superceded)
- `EXECPLAN-PRODUCTION-READY.md` — Critical issues audit

These documents contained valuable context but had overlapping, conflicting, and obsolete information. The consolidated EXECPLAN.md captures the current state accurately.

## System Status

| Component | Status | Notes |
|-----------|--------|-------|
| TypeScript API | ✅ Complete | Port 8000, all endpoints working |
| Web UI | ✅ Complete | Static frontend, session browsing |
| Smart Pruning | ✅ Complete | Configurable extraction system |
| Extraction Storage | ✅ Complete | External file storage, trash integration |
| Lock System | ✅ Complete | OpenClaw-compatible file locking |
| Unit Tests | ✅ Complete | 18 tests passing |
| **OpenClaw Extension** | **❌ DISABLED** | **Active work required — see EXECPLAN.md** |

## Next Actions

See EXECPLAN.md Milestone 1-4 for the critical path to restore extension functionality.
