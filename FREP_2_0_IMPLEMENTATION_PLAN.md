# FREP 2.0 Implementation Plan

## Baseline audit (15 August 2026)

- Stack: Flask, SQLite, vanilla JavaScript; no external service dependency.
- Existing APIs retained: health, dashboard, resources CRUD, bookings, notifications, analytics, clusters, and production plan.
- Existing workflows retained: buyer matching and booking, owner listing management, admin verification, production planning, notifications, cluster map, and analytics.
- Current database is safely initialized with `CREATE TABLE IF NOT EXISTS` and additive `ensure_column` migrations. Existing data will not be deleted.
- Current production planner is deterministic and explainable in concept, but needs richer capacity, trust, logistics, and chain-level calculations.

## Delivery phases

1. **Core intelligence** — configurable match weights, explainable score breakdowns, capacity model, chain optimiser, and estimated Buy/Outsource/FREP comparison.
2. **Trust and transactions** — health/trust data, capacity reservation transactions, booking state machine, owner decisions, verification audit records, and conflict messages.
3. **Network intelligence** — demand insights, cluster metrics/heatmap, owner opportunity alerts, utilization and impact metrics.
4. **Operations and experience** — chain progress, deadline risk, urgent mode, natural-language requirement parsing, scenarios, exports, loading/error states, and accessibility improvements.
5. **Production readiness** — authenticated roles, authorization, audit controls, API standardisation, indexes, expanded tests, and documentation.

## Design constraints

- All recommendations remain deterministic, labelled **estimated** or **demo** where applicable; no unsupported AI/ML claims.
- Existing endpoints and test flows remain backward compatible.
- New persistence is additive and migration-safe.
- Real external verification, payments, maps, and market prices remain integration points rather than simulated facts.
