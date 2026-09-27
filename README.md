# Glassbox

Open-source, self-hosted hackathon submission and judging portal, built for DOGFOOD 2026.

Glassbox runs as a single container with no external services: no hosted database, no hosted auth and no network calls at runtime. It gives you a public project gallery (T1) and judging you can defend (T2). Judges score against a weighted rubric. Calibration removes lenient/harsh judge bias, and the method is explained in the UI. The raw and adjusted rankings are shown side by side, and an append-only, hash-chained audit trail records every change.

- **Claimed tiers:** T1 + T2. The official checker verified both; see [`acceptance-report.txt`](acceptance-report.txt).
- **Stack:** Node 24 + TypeScript (run directly, no build step), built-in `node:sqlite`, server-rendered HTML. The runtime has zero npm dependencies.
- **License:** MIT.
- **Demo video (5:00):** [watch in the browser](https://cdn.jsdelivr.net/gh/sharonbasovich/glassbox-dogfood@main/docs/demo.mp4) · [docs/demo.mp4](docs/demo.mp4)

## Quick start (Docker, offline)

```sh
docker compose up --build        # first run builds from node:24-alpine
open http://localhost:8080
```

Once the `node:24-alpine` image has been pulled, nothing needs the internet. The container has no runtime dependencies to download, and `docker run --network none glassbox:local` works. Data lives in the `glassbox-data` volume (`/data/glassbox.db`).

On first start the empty database is seeded with:

| Event | State | Use it to |
| --- | --- | --- |
| **Sample Hack 2026** (`evt_01`) | Closed; imported from the DOGFOOD `fixtures.json` (8 tracks, 30 judges, 40 teams, 41 projects, 126 scores) | Run the acceptance checker; see calibration on messy real-world-shaped data (flat judges, incomplete reviews, a duplicate submission) |
| **Glassbox Demo Jam** | Open for 7 days from seed time | Create a team, invite teammates, draft and submit |
| **Spring Showcase** | Judging; one lenient and one harsh judge | Score as a judge, watch the live dashboard, compare raw and calibrated rankings, publish |

Demo accounts (password `glassbox-demo`; set `GLASSBOX_ADMIN_PASSWORD` to change the admin's):

| Email | Role |
| --- | --- |
| `admin@glassbox.local` | Instance admin |
| `organizer@glassbox.local` | Organizer of all seeded events |
| `judge1@glassbox.local` … `judge4@glassbox.local` | Judges (Demo Jam, Spring Showcase) |
| `pat@glassbox.local` | Participant with no team yet |
| `ada@glassbox.local` | Member of *Lantern Labs* in Demo Jam |
| `tomas.varga@example.org`, `wei.lindqvist@example.org` | Fixture judges `jdg_01`, `jdg_02` |
| `priya1@example.org` | Fixture participant (team `tm_01`) |

> For a real event, set `GLASSBOX_DEMO_TOKENS=off` and `GLASSBOX_SEED=off` (or change every demo password). With `GLASSBOX_SECURE_COOKIES=1`, cookies are sent only over HTTPS when you run behind TLS.

## Without Docker

```sh
npm ci            # dev-only: TypeScript + @types/node
npm start         # http://localhost:8080, db at data/glassbox.db, auto-seeds when empty
npm run check     # typecheck + test suite
```

Requires Node ≥ 24; it uses type stripping and `node:sqlite`.

## Acceptance checker

```sh
docker compose up -d
python3 tools/run.py .dogfood.toml --fixtures data/fixtures.json > acceptance-report.txt
```

[`.dogfood.toml`](.dogfood.toml) points the checker at the seeded API tokens. All seven checks pass:

| Check | Route | Result |
| --- | --- | --- |
| Gallery is public | `GET /projects` | 200, server-rendered HTML |
| Fixture project shown | `GET /projects` | contains fixture titles |
| Closed event refuses submissions | `POST /api/events/evt_01/projects` | 403 `submissions_closed` (server clock) |
| Judge sees own scores | `GET /api/judges/me/scores` | 200 |
| Judge cannot see a peer's scores | `GET /api/judges/jdg_01/scores` as `jdg_02` | 403 |
| Participant blocked | `GET /api/judges/me/scores` as a participant | 403 |
| CSV export | `GET /api/events/evt_01/export/scores.csv` | 200, one row per score |

## What's in the box

**Participants.** Create an account, create a team or join one with an invite link, then save a draft, submit, keep editing or withdraw. Everything is allowed until the deadline and refused after it. Each team has one canonical project. Published results come with anonymised judge feedback.

**Visitors.** Search the gallery by text and filter by event and track, with sorting. Project pages and published results need no account.

**Judges.** Each judge gets a queue of assigned projects and scores them against the rubric with radio scales. Scores can be revised until results are published. A judge can recuse from a project over a conflict of interest. Judges see only their own scores, enforced in the API.

**Organizers.**
- Create an event, or import a DOGFOOD fixture or Glassbox bundle.
- Set dates, tracks, prizes and a weighted rubric.
- Invite judges; the offline flow issues a one-time setup link.
- Auto-assign reviewers with track affinity and load balancing that never assigns a declared conflict. Manual assign/unassign is also available.
- Watch a live progress dashboard (Server-Sent Events).
- Resolve duplicate submissions and grant per-team deadline extensions.
- Preview the calibrated and raw rankings along with each judge's offset, spread and flags.
- Publish a frozen, hashed results snapshot, or retract it with a reason.
- Export scores, results or projects as CSV, or the whole event as a JSON bundle.
- Browse the audit log with chain verification.

**Admins.** Admins manage platform roles and verify audit-chain integrity for the whole instance.

## Honest limitations

- **Tiers:** only T1 and T2 are built. There is no T3 or T4: no community voting, comments or random ballot order. (Results do stay hidden until an organizer publishes them.)
- **Track scoping works through assignment.** A judge can open and score only the projects assigned to them, and the API enforces this. Auto-assign prefers judges whose tracks match. If no eligible on-track judge is left, it assigns someone off-track and reports how many (`N outside the judge's tracks`) in the UI and the audit log. It does not refuse. Organizers can unassign these by hand.
- **No email delivery.** Glassbox runs offline, so judge invites and team invites are one-time links the organizer or team copies and sends themselves. There is no password-reset flow either.
- **No login rate limiting** beyond the cost of scrypt. Put a reverse-proxy limit on `/login` for internet-facing use (see THREAT-MODEL.md).
- **Single node.** It runs on one SQLite file (WAL mode), which is fine for one event on a laptop or a small VM. It does not scale horizontally.
- **Calibration** works on the weighted total, not on each criterion. It assumes judges saw a comparable mix of projects, and with fewer than about 3 reviews per judge it stays close to raw. See JUDGING.md §7.
- **Demo video:** captions only, no voiceover. It shows the browser flow; the checker run is documented above rather than filmed.

## Provenance

GitHub created the repository's first commit (`e9e0d59`, 2026-09-25) with only a two-line README and the MIT LICENSE. Every line of project code was committed after kickoff (Sat 26 Sep 18:00 UTC), starting with `3b42829` on 2026-09-27 07:05 UTC. `git log --format='%h %aI %s'` shows this.

## Docs

- [ARCHITECTURE.md](ARCHITECTURE.md): components, request flow, where authorization lives.
- [DATA-MODEL.md](DATA-MODEL.md): tables, invariants, what the database enforces.
- [JUDGING.md](JUDGING.md): scoring, calibration maths, a worked example, the limits.
- [THREAT-MODEL.md](THREAT-MODEL.md): roles, attacks considered, mitigations.
- [docs/DEMO.md](docs/DEMO.md): the 5-minute create → submit → judge → publish walkthrough.
- [docs/demo.mp4](docs/demo.mp4): 5-minute recorded browser demo of the same flow (create event → team submits → judge scores → calibrated results → publish → public results and audit).

## CLI

```sh
node src/cli.ts seed [fixtures.json]      # seed an empty database
node src/cli.ts import bundle.json        # import a DOGFOOD fixture / Glassbox bundle
node src/cli.ts export evt_01 out.json    # export an event
node src/cli.ts verify-audit              # verify the audit hash chain
```

Every command reads `GLASSBOX_DB` for the database path. Inside Docker, run `docker compose exec glassbox node src/cli.ts verify-audit`.

## API

A JSON API sits under `/api`. Authenticate with `Authorization: Bearer <token>`; `POST /api/login` returns one. The routes:

- `GET /api/projects`
- `POST /api/events/:event/projects`
- `PATCH /api/projects/:id`, with `{"action":"submit"}` to submit
- `POST /api/events/:event/teams`
- `POST /api/join/:code`
- `GET /api/events/:event/queue`
- `PUT /api/events/:event/scores/:project`
- `GET /api/judges/me/scores`
- `POST /api/events/:event/assignments/auto`
- `GET /api/events/:event/progress`
- `GET /api/events/:event/results/preview`
- `POST /api/events/:event/publish`
- `GET /api/events/:event/results`
- `GET /api/events/:event/export/{scores,results,projects}.csv`
- `GET /api/events/:event/export/bundle.json`
- `POST /api/import`
- `GET /api/events/:event/audit`

Browser sessions use an HttpOnly cookie and require a CSRF token on every write.
