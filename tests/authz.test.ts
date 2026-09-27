import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startSeeded, call, tokenFor, type Harness } from './helpers.ts';
import { CHECKER_TOKENS as T } from '../src/seed.ts';

let h: Harness;
before(async () => { h = await startSeeded(); });
after(async () => { await h.close(); });

test('gallery is public and shows fixture titles; drafts and duplicates are hidden', async () => {
  const r = await call(h.base, 'GET', '/projects');
  assert.equal(r.status, 200);
  assert.match(r.text, /Glass Signal/);
  const api = await call(h.base, 'GET', '/api/projects?q=Dry%20Harbour');
  assert.equal(api.status, 200);
  assert.equal(api.data.items.length, 1, 'duplicate prj_07/prj_41 collapses to one canonical entry');
  const draft = await call(h.base, 'GET', '/api/projects?q=Seed%20Swap');
  assert.equal(draft.data.items.length, 0, 'demo draft is not public');
});

test('authorization matrix for judge scores', async () => {
  const cases: Array<[string, string | undefined, string, number[]]> = [
    ['visitor own', undefined, '/api/judges/me/scores', [401]],
    ['participant own', T.participant, '/api/judges/me/scores', [403]],
    ['judge A own', T.judge_a, '/api/judges/me/scores', [200]],
    ['judge A by id', T.judge_a, '/api/judges/jdg_01/scores', [200]],
    ['judge B -> A', T.judge_b, '/api/judges/jdg_01/scores', [403]],
    ['participant -> A', T.participant, '/api/judges/jdg_01/scores', [403]],
    ['visitor -> A', undefined, '/api/judges/jdg_01/scores', [401]],
    ['organizer -> A', T.organizer, '/api/judges/jdg_01/scores', [200]],
  ];
  for (const [name, token, path, want] of cases) {
    const r = await call(h.base, 'GET', path, token);
    assert.ok(want.includes(r.status), `${name}: got ${r.status} ${r.text.slice(0, 120)}`);
  }
  const own = await call(h.base, 'GET', '/api/judges/me/scores', T.judge_a);
  assert.ok(own.data.scores.length > 0);
  assert.ok(own.data.scores.every((s: { judge_id?: string }) => !s.judge_id || s.judge_id === 'jdg_01'));
});

test('organizer-only surfaces refuse judges, participants and visitors', async () => {
  const paths = ['/api/events/evt_01/export/scores.csv', '/api/events/evt_01/export/results.csv', '/api/events/evt_01/progress', '/api/events/evt_01/results/preview', '/api/events/evt_01/audit', '/api/events/evt_01/export/bundle.json'];
  for (const p of paths) {
    assert.equal((await call(h.base, 'GET', p)).status, 401, `visitor ${p}`);
    for (const tok of [T.participant, T.judge_a]) assert.equal((await call(h.base, 'GET', p, tok)).status, 403, `${tok} ${p}`);
    assert.equal((await call(h.base, 'GET', p, T.organizer)).status, 200, `organizer ${p}`);
  }
  const csv = await call(h.base, 'GET', '/api/events/evt_01/export/scores.csv', T.organizer);
  assert.match(csv.headers.get('content-type') ?? '', /text\/csv/);
  assert.ok(csv.text.split('\r\n')[0]!.includes(','));
  assert.equal(csv.text.trim().split('\r\n').length - 1, 126, 'one row per fixture score');
});

test('organizer of one event has no rights over another event', async () => {
  const other = await tokenFor(h.base, 'admin@glassbox.local');
  const created = await call(h.base, 'POST', '/api/events', other, { name: 'Admin Only Hack', submissions_open_at: '2026-09-20T00:00:00Z', submissions_close_at: '2026-10-20T00:00:00Z' });
  assert.equal(created.status, 201);
  const id = created.data.event.id;
  assert.equal((await call(h.base, 'GET', `/api/events/${id}/export/scores.csv`, T.organizer)).status, 403);
  assert.equal((await call(h.base, 'GET', `/api/events/${id}/export/scores.csv`, other)).status, 200);
});

test('a judge can only score assigned projects, and never compete', async () => {
  const j = await tokenFor(h.base, 'judge1@glassbox.local');
  const queue = await call(h.base, 'GET', '/api/events/evt_demo_judging/queue', j);
  assert.equal(queue.status, 200);
  const assigned = new Set(queue.data.queue.map((q: { project_id: string }) => q.project_id));
  const notMine = ['prj_show_0', 'prj_show_1', 'prj_show_2', 'prj_show_3', 'prj_show_4', 'prj_show_5', 'prj_show_6', 'prj_show_7'].find((p) => !assigned.has(p))!;
  const bad = await call(h.base, 'PUT', `/api/events/evt_demo_judging/scores/${notMine}`, j, { impact: 3, execution: 3, presentation: 3 });
  assert.equal(bad.status, 403);
  const team = await call(h.base, 'POST', '/api/events/evt_demo_open/teams', j, { name: 'Sneaky' });
  assert.equal(team.status, 403);
});

test('team isolation: one team cannot edit another team\'s project', async () => {
  const ada = await tokenFor(h.base, 'ada@glassbox.local');
  const own = await call(h.base, 'PATCH', '/api/projects/prj_demo_0', ada, { summary: 'Edited by owner' });
  assert.equal(own.status, 200);
  const pat = await tokenFor(h.base, 'pat@glassbox.local');
  const other = await call(h.base, 'PATCH', '/api/projects/prj_demo_0', pat, { summary: 'hijack' });
  assert.equal(other.status, 403);
  assert.equal((await call(h.base, 'PATCH', '/api/projects/prj_demo_0', undefined, { summary: 'x' })).status, 401);
  assert.equal((await call(h.base, 'GET', '/api/projects/prj_demo_2')).status, 404, 'drafts are invisible to visitors');
  assert.equal((await call(h.base, 'GET', '/api/projects/prj_demo_2', pat)).status, 404, 'and to other participants');
});

test('cookie-authenticated writes require the CSRF token', async () => {
  const login = await fetch(h.base + '/login', { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'email=pat%40glassbox.local&password=glassbox-demo' });
  const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
  const r = await fetch(h.base + '/api/events/evt_demo_open/teams', { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: '{"name":"CSRF"}' });
  assert.equal(r.status, 403);
  assert.equal(((await r.json()) as { error: { code: string } }).error.code, 'csrf');
});
