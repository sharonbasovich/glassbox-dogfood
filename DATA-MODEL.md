# Data model

The schema lives in `src/db/001_init.sql`. IDs are prefixed strings (`evt_`, `tm_`, `prj_`, `usr_`, …); the importer keeps fixture IDs when they're free. Timestamps are ISO-8601 UTC strings, so string comparison matches time order.

```
users ─< sessions
users ─< event_roles >─ events ─< tracks
                          │ ├──< prizes
                          │ ├──< criteria (weighted rubric)
                          │ ├──< teams ─< team_members >─ users
                          │ │       └──< deadline_extensions
                          │ ├──< projects (team, track, duplicate_of → projects)
                          │ ├──< assignments (judge × project) ─< scores ─< score_values (criterion)
                          │ ├──< conflicts (judge × team)
                          │ └──< result_publications (frozen JSON + sha256)
audit_log (seq, prev_hash, hash, actor, event, action, subject, detail)
```

| Table | Purpose / notable columns |
| --- | --- |
| `users` | `email` (unique, lower-case), `password_hash` (scrypt; NULL for invited users until they claim), `platform_role` ∈ user/organizer/admin |
| `sessions` | `token_hash` (SHA-256 of the bearer/cookie token), `kind` browser/api, `csrf_token`, `expires_at` |
| `account_claims` | one-time links that let invited judges and imported participants set a password |
| `events` | dates (`submissions_open_at`, `submissions_close_at`, `judging_close_at`), `visibility`, `max_team_size`, `reviews_per_project`, `normalization`, `shrinkage_k`, `results_published_at` |
| `event_roles` | (event, user, role ∈ organizer/judge) |
| `teams`, `team_members` | invite code per team; `UNIQUE(event_id, user_id)` means one team per person per event |
| `projects` | `status` draft/submitted, `submitted_at`, `duplicate_of`, `source_ref` (original fixture ID) |
| `criteria` | `key`, `weight` (relative), `scale_min`, `scale_max`, `position` |
| `assignments` | (judge, project), `source` auto/manual/import |
| `scores`, `score_values` | one score per (judge, project) with a comment; one value per criterion |
| `result_publications` | `payload` (JSON), `payload_hash`, `retracted_at` (reason recorded in the audit log) |
| `audit_log` | `seq`, `prev_hash`, `hash = sha256(prev_hash ‖ canonical row)` |

## Invariants the database enforces

- One team per participant per event: `team_members UNIQUE (event_id, user_id)`.
- One canonical project per team: a partial unique index on `projects(team_id) WHERE duplicate_of IS NULL`.
- A score needs an assignment: `scores (judge_id, project_id)` references `assignments`, so an unassigned score can't exist even by direct SQL.
- Score values reference the event's criteria; there's one row per (score, criterion).
- The audit log can't be edited: `BEFORE UPDATE` and `BEFORE DELETE` triggers raise errors. A tampered row breaks the hash chain, and `verify-audit` reports the first broken `seq`.
- Foreign keys are on (`PRAGMA foreign_keys = ON`), with cascades from events.

## Invariants the service layer enforces

- Deadlines come from the server clock, including per-team extensions (`assertSubmissionWindow`).
- A user can't be both judge and participant in the same event, in either order.
- Team size stays within `max_team_size`, and teams lock when submissions close.
- Criteria that already have scores can't be deleted or rescaled.
- Scoring is locked once results are published.

## Fixture mapping

| `fixtures.json` | Glassbox |
| --- | --- |
| `event` | `events` (dates kept; imported closed) |
| `tracks[]` | `tracks` |
| `judges[]` | `users` + `event_roles(judge)`; password-less until claimed |
| `teams[].members[]` | `users` + `team_members` (a judge who also appears as a member is kept as judge only, with a warning) |
| `projects[]` | `projects`. A team with more than one entry keeps the **latest** submission as canonical; the rest get `duplicate_of`. |
| `scores[]` | `assignments(source=import)` + `scores` + `score_values`. Criteria are inferred from score keys, equally weighted. |

Teams that share a name are imported with the ID appended, e.g. `StillTrail (tm_30)`, and the import report lists each one.
