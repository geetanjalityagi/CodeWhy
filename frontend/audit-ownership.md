# Frontend audit fix — file ownership

Scope: P0 functional-integrity fixes plus the approved P1 state, accessibility,
clipboard and search-race pass. Layout findings remain deferred.

Owner: frontend audit branch work (`ui-polish`). No backend, contract or recorded-fixture changes.

## Files changed

| File | Change |
| --- | --- |
| `frontend/src/components/DecisionHistoryView.tsx` | Load repo-wide decisions when no question context exists |
| `frontend/src/components/GraphExplorerView.tsx` | Load repo-wide graph; search and filters without a question; working full-graph reset |
| `frontend/src/components/IntelligenceWorkspace.tsx` | Clear stale results on repo switch; drop out-of-order answers; real clipboard success/failure feedback |
| `frontend/src/components/RepositoryStatusView.tsx` | Poll failures no longer leave the refresh button stuck; status labels derived from runtime state instead of hardcoded claims |
| `frontend/src/components/DecisionDrawer.tsx` | Clear stale detail on a failed load; stop refetching on parent re-render; dialog semantics, focus trap/restore, Escape dismissal; clipboard failure feedback; citation-click feedback |
| `frontend/src/components/RepositorySelectorModal.tsx` | Dialog semantics, labelled title, initial focus, Tab trap, Escape dismissal, focus restore, keyboard-activatable repository rows |
| `frontend/src/components/FileDecisionBriefView.tsx` | Monotonic search sequence so an older file search cannot overwrite a newer one; cleared results when the query is emptied |
| `frontend/src/index.css` | Workbench-wide `:focus-visible` outline; landing-page outline unchanged |
| `frontend/src/components/GraphExplorerView.test.tsx` | Replace the dead-end empty-state assertion |
| `frontend/src/phase1-fixtures.test.tsx` | Fix a mock entity shape that broke `tsc -b` |
| `frontend/src/components/p0-regressions.test.tsx` | Regression tests for the five P0 behaviors |
| `frontend/src/components/p1-regressions.test.tsx` | Regression tests for dialog keyboard/focus, clipboard failure, status honesty and the search race |

## Not touched

`backend/`, `contract/`, `frontend/fixtures/recorded/`, `frontend/API_REALITY.md`.
Those paths belong to the other agent's in-flight work.

## Endpoints used (verified in `frontend/API_REALITY.md`)

- `GET /api/v1/repositories/{id}/decisions` — no `entity_id` returns the full repo history (`total`, `limit`, `offset`, `fixture`).
- `GET /api/v1/repositories/{id}/graph` — no `entity_id` returns the repo-wide bounded graph (`nodes`, `edges`, `truncated`, `fixture`).
- `GET /api/v1/repositories/{id}` — can fail; callers must handle rejection.
- `GET /api/v1/decisions/{id}` — can fail; callers must clear previous detail.
