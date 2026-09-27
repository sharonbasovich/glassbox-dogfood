# 5-minute demo: create → submit → judge → publish

Setup (before recording): run `docker compose up`, open http://localhost:8080, and keep two browser windows side by side (or one normal and one private). All passwords are `glassbox-demo`.

| Time | Window | Action | What to say |
| --- | --- | --- | --- |
| 0:00 | A | Home → **Gallery**: type "signal", filter by track | "Public gallery: search and filter, no account needed. 40 projects from the official DOGFOOD fixture, plus two live demo events." |
| 0:30 | A | Sign in as `organizer@glassbox.local` → **New event**: name "Demo Night", closes in 1 hour, tracks "AI, Civic" → Create → **Setup**: change the Innovation weight → Save | "Organizers set dates, tracks, prizes and a weighted rubric. Everything is audited." |
| 1:15 | B | Sign in as `pat@glassbox.local` → **Glassbox Demo Jam** → Create team → copy the invite link → **Submit**: fill the title, save draft, then **Submit project** | "Drafts are private. Submit, keep editing until the deadline, withdraw if needed. One project per team." |
| 2:00 | B | Terminal: `curl -X POST localhost:8080/api/events/evt_01/projects -H 'Authorization: Bearer gbx_demo_participant_2e88f16b' -d '{"title":"late"}'` → **403 submissions_closed** | "Deadlines come from the server clock, not the UI. The API refuses late work." |
| 2:20 | B | Sign out → sign in as `judge1@glassbox.local` → **Spring Showcase → Judge** → score a project → "Save and next" | "Judges see only their queue and their own scores." |
| 2:45 | A | Organizer → **Spring Showcase → Manage** (the live dashboard already open): the counter ticks as the judge saves | "Live progress over Server-Sent Events, which works offline." |
| 3:00 | B | Terminal: `curl localhost:8080/api/judges/jdg_01/scores -H 'Authorization: Bearer gbx_demo_judge_b_44de7a5d'` → **403** | "Judge isolation is enforced by the API; all seven checker steps pass." |
| 3:15 | A | **Results** tab: the calibrated vs raw ranking with ▲▼ arrows, and the judge calibration table (*Sam Lenient* +, *Taylor Tough* −) | "Sam gives everyone 5s, Taylor gives 1s. Shrunk z-scores remove that bias. The method is explained on /judging, and here are both rankings side by side." |
| 4:00 | A | **Publish results** → open the public results page → point at the hash | "Publishing freezes a hashed snapshot and locks scoring. The public page shows aggregates only." |
| 4:30 | A | **Audit log** tab: "Chain intact", then **Setup → Scores CSV** | "Every action is in an append-only, hash-chained log. Export CSV for spreadsheets." |
| 4:50 | — | Show `acceptance-report.txt` | "Single container, no internet at runtime, MIT licensed." |

Backup: if the live event creation is slow, skip to **Glassbox Demo Jam**, which is already open.
