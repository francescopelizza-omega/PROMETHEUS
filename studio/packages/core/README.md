# @prometheus/core

Shared, UI-agnostic domain layer used by both `apps/desktop` and `apps/cli`: data models
(`Env`, `Package`, `Model`, `Repo`, `CatalogItem`, `Verdict`, …), business logic, and the
feature-command surface that the GUI and CLI both render.

Depends on `@prometheus/engine-bridge` for all engine access.

Spec → [`../../../MDS/the_real_prometheus/`](../../../MDS/the_real_prometheus/) (all feature files).
