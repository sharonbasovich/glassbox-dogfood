/**
 * Cross-judge normalization. Pure functions, no I/O: the same code produces
 * the organizer dashboard, the CSV export and the published results.
 * The method is documented and defended in JUDGING.md.
 */

export interface CriterionSpec {
  id: string;
  key: string;
  weight: number;
  scale_min: number;
  scale_max: number;
}

export interface Review {
  judgeId: string;
  projectId: string;
  values: Record<string, number>; // criterion id -> value
}

export type Method = 'none' | 'zscore_shrunk';

export interface JudgeCalibration {
  judgeId: string;
  n: number;
  rawMean: number;
  rawSd: number;
  shrunkMean: number;
  shrunkSd: number;
  /** shrunkMean - global mean, in points. Positive = lenient. */
  offset: number;
  /** shrunkSd / global sd. Below 1 = compresses the scale. */
  spread: number;
  flags: Array<'flat' | 'single_review' | 'lenient' | 'harsh' | 'compressed'>;
}

export interface ReviewOutcome {
  judgeId: string;
  projectId: string;
  raw: number;
  z: number;
  adjusted: number;
}

export interface ProjectResult {
  projectId: string;
  reviews: number;
  raw: number;
  adjusted: number;
  /** Standard error of the adjusted mean, in points. */
  stderr: number;
  rawRank: number;
  rank: number;
  criteria: Record<string, number>; // criterion key -> mean raw value
}

export interface Outcome {
  method: Method;
  k: number;
  globalMean: number;
  globalSd: number;
  judges: JudgeCalibration[];
  reviews: ReviewOutcome[];
  projects: ProjectResult[];
}

/** Weighted total on a 0-100 scale. Missing criteria are skipped and the remaining weights renormalised. */
export function weightedTotal(criteria: CriterionSpec[], values: Record<string, number>): number | null {
  let acc = 0;
  let wsum = 0;
  for (const c of criteria) {
    const v = values[c.id];
    if (v === undefined || !Number.isFinite(v)) continue;
    acc += c.weight * ((v - c.scale_min) / (c.scale_max - c.scale_min));
    wsum += c.weight;
  }
  return wsum > 0 ? (100 * acc) / wsum : null;
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const ss = (xs: number[], m: number) => xs.reduce((a, x) => a + (x - m) ** 2, 0);
export const round = (x: number, d = 2) => Math.round(x * 10 ** d) / 10 ** d;

export function normalize(criteria: CriterionSpec[], input: Review[], method: Method, k = 3, projectIds?: string[]): Outcome {
  const reviews = input
    .map((r) => ({ ...r, raw: weightedTotal(criteria, r.values) }))
    .filter((r): r is Review & { raw: number } => r.raw !== null);
  const totals = reviews.map((r) => r.raw);
  const mu = mean(totals);
  const sigma = totals.length > 1 ? Math.sqrt(ss(totals, mu) / totals.length) : 0;

  const byJudge = new Map<string, number[]>();
  for (const r of reviews) byJudge.set(r.judgeId, [...(byJudge.get(r.judgeId) ?? []), r.raw]);

  const judges: JudgeCalibration[] = [];
  const calib = new Map<string, { m: number; s: number }>();
  for (const [judgeId, xs] of byJudge) {
    const n = xs.length;
    const m = mean(xs);
    const rawSd = n > 1 ? Math.sqrt(ss(xs, m) / (n - 1)) : 0;
    // Empirical-Bayes style shrinkage: a judge's mean and variance are blended
    // with the pool, weighted by k pseudo-reviews. Few reviews => close to pool.
    const shrunkMean = (n * m + k * mu) / (n + k);
    const shrunkVar = n - 1 + k > 0 ? (ss(xs, m) + k * sigma ** 2) / (n - 1 + k) : 0;
    const shrunkSd = Math.sqrt(shrunkVar);
    calib.set(judgeId, { m: shrunkMean, s: shrunkSd });
    const flags: JudgeCalibration['flags'] = [];
    if (n >= 2 && rawSd === 0) flags.push('flat');
    if (n === 1) flags.push('single_review');
    if (sigma > 0 && shrunkMean - mu > 0.5 * sigma) flags.push('lenient');
    if (sigma > 0 && shrunkMean - mu < -0.5 * sigma) flags.push('harsh');
    if (sigma > 0 && n >= 2 && shrunkSd < 0.75 * sigma) flags.push('compressed');
    judges.push({
      judgeId, n, rawMean: round(m), rawSd: round(rawSd), shrunkMean: round(shrunkMean), shrunkSd: round(shrunkSd),
      offset: round(shrunkMean - mu), spread: sigma > 0 ? round(shrunkSd / sigma, 3) : 1, flags,
    });
  }
  judges.sort((a, b) => a.judgeId.localeCompare(b.judgeId));

  const outcomes: ReviewOutcome[] = reviews.map((r) => {
    const c = calib.get(r.judgeId)!;
    const usable = method === 'zscore_shrunk' && sigma > 0 && c.s > 0;
    const z = usable ? (r.raw - c.m) / c.s : sigma > 0 ? (r.raw - mu) / sigma : 0;
    const adjusted = usable ? mu + sigma * z : r.raw;
    return { judgeId: r.judgeId, projectId: r.projectId, raw: round(r.raw), z: round(z, 3), adjusted: round(adjusted) };
  });

  const ids = projectIds ?? [...new Set(reviews.map((r) => r.projectId))];
  const byProject = new Map<string, ReviewOutcome[]>();
  for (const o of outcomes) byProject.set(o.projectId, [...(byProject.get(o.projectId) ?? []), o]);
  const rawByProject = new Map<string, Array<Record<string, number>>>();
  for (const r of reviews) rawByProject.set(r.projectId, [...(rawByProject.get(r.projectId) ?? []), r.values]);

  const projects: ProjectResult[] = ids.map((projectId) => {
    const os = byProject.get(projectId) ?? [];
    const crit: Record<string, number> = {};
    for (const c of criteria) {
      const vs = (rawByProject.get(projectId) ?? []).map((v) => v[c.id]).filter((v): v is number => v !== undefined);
      if (vs.length) crit[c.key] = round(mean(vs));
    }
    const adj = os.map((o) => o.adjusted);
    return {
      projectId,
      reviews: os.length,
      raw: round(mean(os.map((o) => o.raw))),
      adjusted: round(mean(adj)),
      stderr: os.length ? round(sigma / Math.sqrt(os.length)) : 0,
      rawRank: 0,
      rank: 0,
      criteria: crit,
    };
  });

  // Unreviewed projects sink to the bottom; ties break on raw, then coverage, then id.
  const rankBy = (key: 'raw' | 'adjusted') =>
    [...projects].sort(
      (a, b) =>
        Number(b.reviews > 0) - Number(a.reviews > 0) ||
        b[key] - a[key] ||
        b.raw - a.raw ||
        b.reviews - a.reviews ||
        a.projectId.localeCompare(b.projectId),
    );
  rankBy('raw').forEach((p, i) => (p.rawRank = i + 1));
  rankBy(method === 'none' ? 'raw' : 'adjusted').forEach((p, i) => (p.rank = i + 1));
  projects.sort((a, b) => a.rank - b.rank);

  return { method, k, globalMean: round(mu), globalSd: round(sigma), judges, reviews: outcomes, projects };
}

/** Spearman rank correlation, used by the normalization proof tests. */
export function spearman(a: number[], b: number[]): number {
  const ranks = (xs: number[]) => {
    const idx = xs.map((x, i) => [x, i] as const).sort((p, q) => p[0] - q[0]);
    const r = new Array<number>(xs.length);
    idx.forEach(([, i], pos) => (r[i] = pos + 1));
    return r;
  };
  const ra = ranks(a);
  const rb = ranks(b);
  const n = a.length;
  const d2 = ra.reduce((acc, r, i) => acc + (r - rb[i]!) ** 2, 0);
  return 1 - (6 * d2) / (n * (n * n - 1));
}
