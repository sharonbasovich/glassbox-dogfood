import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalize, spearman, weightedTotal, type CriterionSpec, type Review } from '../src/scoring/normalize.ts';

const rubric: CriterionSpec[] = [
  { id: 'c1', key: 'a', weight: 2, scale_min: 1, scale_max: 5 },
  { id: 'c2', key: 'b', weight: 1, scale_min: 1, scale_max: 5 },
];

test('weighted total maps the rubric onto 0-100 using relative weights', () => {
  assert.equal(weightedTotal(rubric, { c1: 5, c2: 5 }), 100);
  assert.equal(weightedTotal(rubric, { c1: 1, c2: 1 }), 0);
  assert.equal(Math.round(weightedTotal(rubric, { c1: 5, c2: 1 })! * 100) / 100, 66.67);
  assert.equal(weightedTotal(rubric, { c1: 5 }), 100, 'incomplete review is averaged over the criteria it has');
  assert.equal(weightedTotal(rubric, {}), null, 'an empty review is not a score');
});

// Deterministic PRNG so the proof is reproducible.
function rng(seed: number) {
  return () => { seed = (seed * 1664525 + 1013904223) % 2 ** 32; return seed / 2 ** 32; };
}

/**
 * Proof by simulation: projects have a true quality; judges add a personal
 * bias (lenient/harsh) and scale compression. Each project is seen by 3 of 12
 * judges. Calibrated ranking must track true quality better than raw means.
 */
test('calibration recovers the true ranking better than raw means under judge bias', () => {
  const clamp = (x: number) => Math.max(1, Math.min(5, Math.round(x)));
  let wins = 0;
  let gain = 0;
  const seeds = [1, 2, 3, 4, 5, 6, 7, 8];
  for (const s of seeds) {
    const rand = rng(s);
    const nProjects = 60;
    const truth = Array.from({ length: nProjects }, () => 1.5 + rand() * 3);
    const judges = Array.from({ length: 12 }, (_, j) => ({ id: `j${j}`, bias: (rand() - 0.5) * 2.4, scale: 0.4 + rand() * 0.9 }));
    const reviews: Review[] = [];
    truth.forEach((q, p) => {
      for (let r = 0; r < 3; r++) {
        const j = judges[(p * 5 + r * 7) % judges.length]!;
        const v = () => clamp(3 + (q - 3) * j.scale + j.bias + (rand() - 0.5) * 0.6);
        reviews.push({ judgeId: j.id, projectId: `p${p}`, values: { c1: v(), c2: v() } });
      }
    });
    const scoresOf = (o: ReturnType<typeof normalize>) => truth.map((_, p) => o.projects.find((x) => x.projectId === `p${p}`)!.adjusted);
    const rhoRaw = spearman(truth, scoresOf(normalize(rubric, reviews, 'none')));
    const rhoCal = spearman(truth, scoresOf(normalize(rubric, reviews, 'zscore_shrunk', 3)));
    if (rhoCal > rhoRaw) wins++;
    gain += rhoCal - rhoRaw;
  }
  assert.ok(wins >= seeds.length - 1, `calibration won ${wins}/${seeds.length} simulations`);
  assert.ok(gain / seeds.length > 0.01, `mean rank-correlation gain ${(gain / seeds.length).toFixed(3)}`);
});

test('a uniformly lenient judge gets a positive offset that is removed', () => {
  const reviews: Review[] = [];
  for (let p = 0; p < 6; p++) {
    const base = 1 + (p % 5);
    reviews.push({ judgeId: 'fair', projectId: `p${p}`, values: { c1: base, c2: base } });
    reviews.push({ judgeId: 'kind', projectId: `p${p}`, values: { c1: Math.min(5, base + 1), c2: 5 } });
  }
  const out = normalize(rubric, reviews, 'zscore_shrunk', 3);
  const kind = out.judges.find((j) => j.judgeId === 'kind')!;
  const fair = out.judges.find((j) => j.judgeId === 'fair')!;
  assert.ok(kind.offset > 0 && fair.offset < 0);
  assert.ok(kind.flags.includes('lenient') || kind.offset > 5);
});

test('a flat judge is flagged and does not reorder projects', () => {
  const reviews: Review[] = [
    { judgeId: 'a', projectId: 'x', values: { c1: 5, c2: 5 } },
    { judgeId: 'a', projectId: 'y', values: { c1: 2, c2: 2 } },
    { judgeId: 'a', projectId: 'z', values: { c1: 3, c2: 3 } },
    { judgeId: 'flat', projectId: 'x', values: { c1: 3, c2: 3 } },
    { judgeId: 'flat', projectId: 'y', values: { c1: 3, c2: 3 } },
    { judgeId: 'flat', projectId: 'z', values: { c1: 3, c2: 3 } },
  ];
  const out = normalize(rubric, reviews, 'zscore_shrunk', 3);
  assert.ok(out.judges.find((j) => j.judgeId === 'flat')!.flags.includes('flat'));
  const rankOf = (id: string) => out.projects.find((p) => p.projectId === id)!.rank;
  assert.deepEqual([rankOf('x'), rankOf('z'), rankOf('y')], [1, 2, 3]);
  for (const r of out.reviews) assert.ok(Number.isFinite(r.adjusted));
});

test('method "none" ranks by raw weighted mean; unreviewed projects rank last', () => {
  const reviews: Review[] = [
    { judgeId: 'a', projectId: 'x', values: { c1: 4, c2: 4 } },
    { judgeId: 'a', projectId: 'y', values: { c1: 5, c2: 5 } },
  ];
  const out = normalize(rubric, reviews, 'none', 3, ['x', 'y', 'ghost']);
  const byId = Object.fromEntries(out.projects.map((p) => [p.projectId, p]));
  assert.equal(byId.y!.rank, 1);
  assert.equal(byId.x!.rank, 2);
  assert.equal(byId.ghost!.reviews, 0);
  assert.equal(byId.ghost!.rank, 3);
  assert.equal(byId.x!.adjusted, byId.x!.raw);
});

test('normalization is deterministic regardless of input order', () => {
  const reviews: Review[] = [];
  for (let p = 0; p < 8; p++) for (const j of ['a', 'b', 'c']) reviews.push({ judgeId: j, projectId: `p${p}`, values: { c1: 1 + ((p * 3 + j.charCodeAt(0)) % 5), c2: 1 + ((p + j.charCodeAt(0)) % 5) } });
  const a = normalize(rubric, reviews, 'zscore_shrunk', 3);
  const b = normalize(rubric, [...reviews].reverse(), 'zscore_shrunk', 3);
  assert.deepEqual(a.projects.map((p) => [p.projectId, p.rank, p.adjusted]).sort(), b.projects.map((p) => [p.projectId, p.rank, p.adjusted]).sort());
});
