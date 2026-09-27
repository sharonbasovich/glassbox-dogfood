# How judging works

The goal is a ranking you can defend to a team that asks "why did we come 7th?". Every step below can be seen in the organizer UI (**Manage → Results**), and the CSVs reproduce it.

## 1. The rubric

Organizers define criteria with a **relative weight** and an integer scale. The default is 1–5: Functionality 40%, Quality 35%, Innovation 25%. Judges and teams see the weights as percentages.

A single review becomes one number on a 0–100 scale:

```
total = 100 × Σ wᵢ · (vᵢ − minᵢ)/(maxᵢ − minᵢ)  /  Σ wᵢ      (over the criteria the review has)
```

For incomplete reviews, such as some imported fixture rows, only the criteria that are present are averaged. A review with no values isn't a score at all.

## 2. Why raw averages aren't fair

Judges differ. Some give everything 4–5 (**lenient**), some rarely go above 3 (**harsh**), and some use only the middle of the scale (**compressed**). With 3 reviews per project, the luck of *which* judges you drew moves you several places. Z-scoring each judge fixes that but overreacts for a judge with only 2–3 reviews, because their mean and spread are mostly noise.

## 3. Calibration: shrunk z-scores (`zscore_shrunk`, default)

Let μ and σ be the mean and standard deviation of all review totals in the event (the pool). For judge *j* with *n* reviews, mean *m*, and sum of squared deviations *S*:

```
m̃ = (n·m + k·μ) / (n + k)                 shrunk mean
s̃ = √( (S + k·σ²) / (n − 1 + k) )          shrunk spread
z  = (total − m̃) / s̃                      how unusual this review is *for this judge*
adjusted = μ + σ·z                          back on the familiar 0–100 scale
```

*k* is the number of pseudo-reviews (per event, default 3). A judge with 2 reviews is pulled most of the way back to the pool, so they're barely corrected. A judge with 20 reviews is corrected almost entirely by their own behaviour. If *k* = 0 this is a classic per-judge z-score. If *k* → ∞ it's the raw score.

A project's calibrated score is the mean of its adjusted reviews. The UI shows ±σ/√reviews next to it so organizers can see which gaps are within noise. Unreviewed projects rank last, and ties break on raw score, then review count, then ID, so the order is fully deterministic.

Each judge is shown with:

| Column | Meaning |
| --- | --- |
| **Offset** | m̃ − μ in points: + is lenient, − is harsh |
| **Spread** | s̃ / σ: below 1 means they compress the scale |
| **flat** | every review identical (their z is 0, so they don't reorder anything) |
| **single_review** | only one review; almost no correction possible |
| **lenient / harsh** | \|offset\| > 0.5σ |
| **compressed** | spread < 0.75 |

Set `normalization = none` to rank by raw weighted means. The raw rank is always shown next to the calibrated one either way.

## 4. Worked example: the DOGFOOD fixture (`evt_01`)

The fixture has 126 reviews from 30 judges, and most projects get 3. Calibration flags **Wei Lindqvist** (`jdg_02`) as lenient: a raw mean of 80.6 against the pool, which shrinks to an offset of +10.8 points over 6 reviews. Their reviews are pulled down accordingly. **Otto Brandt** (`jdg_20`) sits at −7.7, so his reviews are pulled up.

| Calibrated # | Raw # | Project | Reviews | Raw | Calibrated |
| --- | --- | --- | --- | --- | --- |
| 1 | 2 | Iron Switch | 3 | 83.3 | 82.2 |
| 2 | 1 | Salt Ledger | 4 | 83.3 | 78.5 |
| 3 | 7 | Slow Trail | 3 | 75.0 | 78.5 |
| 4 | 5 | Salt Loom | 4 | 77.1 | 76.3 |
| 5 | 4 | Dry Relay | 3 | 77.8 | 74.9 |

*Slow Trail* climbs from 7th to 3rd because two of its three judges are harsh. *Salt Ledger*'s raw tie for first came partly from a lenient judge. Twelve projects move by three or more places. These are the conversations an organizer should have *before* publishing, and the results page makes them visible.

The duplicate submission (`prj_07`/`prj_41`, team `tm_07`) collapses to its latest entry; duplicates never enter the ranking. Flat judges get a flag, and their reviews carry no ordering information.

## 5. Evidence that it helps

`tests/normalize.test.ts` simulates 8 events. Each has 60 projects with a known true quality and 12 judges with random bias and scale compression, and each project is seen by 3 judges. The test measures the Spearman correlation of each ranking with the truth:
- the calibrated ranking must beat the raw ranking in at least 7 of 8 events, and
- the mean improvement must be positive.

Other tests check that lenient judges get a positive offset, flat judges don't reorder projects, results are order-independent, and `none` equals the raw ranking.

## 6. Publishing and trust

- **Publish** freezes the full ranking as JSON, stores its SHA-256 (shown on the public page), and locks scoring.
- Public results show only aggregates. Per-judge scores never leave the organizer view.
- Teams see their judges' comments anonymously.
- **Retract** needs a reason. Both actions go into the hash-chained audit log, as does every score write (with its values), assignment, rubric change, extension and duplicate decision.
- `GET /api/events/:id/export/scores.csv` has one row per review: raw values, weighted total, z, the judge's offset and spread, and the adjusted score. Anyone with the export can re-derive the ranking in a spreadsheet.

## 7. Known limits

- Calibration assumes judges saw a comparable mix of projects. If one judge happened to get only the best projects, they'll look lenient. Auto-assignment balances load and breaks ties with a deterministic hash to limit this, and the ± column shows the uncertainty. A pairwise or Bradley–Terry model would handle it better, and we left that out on purpose for explainability.
- Criteria are calibrated together (on the weighted total), not one by one.
- With fewer than ~3 reviews per judge, calibration is intentionally close to raw.
