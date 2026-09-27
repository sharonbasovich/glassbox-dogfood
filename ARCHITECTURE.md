# Architecture

```
browser ──HTML forms / SSE──┐
                            ├──► src/app.ts ── router ──► web/* (thin handlers) ──► services/* ──► node:sqlite (WAL)
scripts/checker ──JSON API──┘        │                                             │
                                     └─ resolveActor (cookie | bearer), CSRF        └─ audit.ts (hash chain)
```

## Components

| Path | Responsibility |
| --- | --- |
| `src/server.ts` | Process entry: opens the DB, runs migrations, seeds on first boot, starts HTTP. |
| `src/app.ts` | Request pipeline: static files, route match, actor resolution, CSRF, error mapping (JSON for `/api`, redirects with flash messages for forms, HTML error pages), security headers (CSP, frame-deny, nosniff). |
| `src/http/router.ts` | ~150-line router: path params, cookies, JSON and form bodies (size-capped), reply helpers. |
| `src/db/` | `openDb`, forward-only SQL migrations, nested transactions via savepoints. |
| `src/services/auth.ts` | scrypt password hashes, session tokens (stored as SHA-256), API tokens, one-time claim links. |
| `src/services/authz.ts` | **Every authorization decision**: `requireOrganizer`, `requireJudge`, `teamMembership`, `canViewProject`, … |
| `src/services/{events,teams,projects,judging,results,csv,importer}.ts` | Domain logic. Each exported write takes an `Actor` and authorizes it first. |
| `src/scoring/normalize.ts` | Pure calibration function (no DB), unit-tested separately. See JUDGING.md. |
| `src/services/audit.ts` | Append-only, SHA-256 chained log; `verifyAuditChain`. |
| `src/services/live.ts` | In-process event emitter → Server-Sent Events for the organizer dashboard. |
| `src/web/` | HTML pages (tagged-template `h` with escaping by default) and the JSON API. Handlers never make authorization decisions themselves beyond "is anyone signed in". |

## Key decisions

- **Authorization lives in the service layer, not the UI.** The HTML and the API call the same service functions, so a hidden button is never the only protection. Tests (`tests/authz.test.ts`) hit the HTTP API directly with each role.
- **The server clock decides deadlines.** `assertSubmissionWindow()` is the only deadline check, and every project write calls it (create, edit, submit, withdraw) no matter whether the write comes from a form, the API or a script. A team's extension replaces the close time for that team only.
- **Zero runtime dependencies.** Node 24 runs the `.ts` sources directly, and `node:sqlite` is built in. `npm ci` isn't needed to run the app, only to typecheck. The Docker image copies the sources and nothing else, so it starts with no network.
- **SQLite in WAL mode.** One file holds everything, so backup is `cp` (or `sqlite3 .backup`). One writer with many readers is plenty for a hackathon: a few hundred teams and a few thousand scores. Every multi-row change runs in a transaction.
- **Results are frozen snapshots.** Publishing stores the computed ranking as JSON with its SHA-256 and locks scoring. Public pages serve the snapshot; they never recompute it and never expose per-judge rows. Retracting a snapshot needs a reason, and both actions are audited.
- **Server-rendered HTML with a little inline JS.** JS is used only for copy-to-clipboard and the SSE refresh. Pages are fast, work without JS, are accessible by default, and there's no frontend build.

## Request lifecycle (score submission)

1. `POST /e/:event/judge/:project` arrives with the session cookie and `_csrf`.
2. `app.ts` resolves the actor from the cookie and checks the CSRF token against the session.
3. The handler calls `upsertScore(db, clock, actor, eventId, projectId, body)`. That function:
   - requires the actor to be a judge of this event,
   - requires an assignment row, which blocks unassigned projects and projects the judge recused from,
   - refuses once results are published,
   - validates each criterion against its scale,
   - writes in a transaction,
   - appends an audit entry.
4. `notify(event, 'score')` pushes an SSE ping to open organizer dashboards, which fetch a fresh progress fragment.
