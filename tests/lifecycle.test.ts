import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startSeeded, call, tokenFor } from './helpers.ts';
import { CHECKER_TOKENS as T } from '../src/seed.ts';
import { verifyAuditChain } from '../src/services/audit.ts';
import { run } from '../src/db/index.ts';

test('deadline is enforced by the server clock, with per-team extensions', async () => {
  const h = await startSeeded('2026-09-26T12:00:00Z');
  try {
    // Closed fixture event refuses submissions (checker step 3).
    const closed = await call(h.base, 'POST', '/api/events/evt_01/projects', T.participant, { title: 'Late' });
    assert.equal(closed.status, 403);
    assert.equal(closed.data.error.code, 'submissions_closed');

    const pat = await tokenFor(h.base, 'pat@glassbox.local');
    assert.equal((await call(h.base, 'POST', '/api/events/evt_demo_open/teams', pat, { name: 'Pat Squad' })).status, 201);
    const created = await call(h.base, 'POST', '/api/events/evt_demo_open/projects', pat, { title: 'Pat Project', summary: 'Hi' });
    assert.equal(created.status, 201);
    assert.equal(created.data.project.status, 'draft');
    const id = created.data.project.id;
    assert.equal((await call(h.base, 'GET', `/api/projects/${id}`)).status, 404, 'draft not public');
    const sub = await call(h.base, 'PATCH', `/api/projects/${id}`, pat, { action: 'submit' });
    assert.equal(sub.status, 200);
    assert.equal(sub.data.project.status, 'submitted');
    assert.equal((await call(h.base, 'GET', `/api/projects/${id}`)).status, 200);
    assert.equal((await call(h.base, 'POST', '/api/events/evt_demo_open/projects', pat, { title: 'Second' })).status, 409, 'one project per team');

    h.clock.advanceHours(24 * 7 + 1);
    const late = await call(h.base, 'PATCH', `/api/projects/${id}`, pat, { summary: 'after deadline' });
    assert.equal(late.status, 403);
    assert.equal(late.data.error.code, 'submissions_closed');

    // Organizer grants an extension to this team only.
    const team = (await call(h.base, 'GET', '/api/events/evt_demo_open/team', pat)).data.team;
    const until = new Date(h.clock.now().getTime() + 3600_000).toISOString();
    const org = await tokenFor(h.base, 'organizer@glassbox.local');
    const { grantExtension } = await import('../src/services/projects.ts');
    const { resolveActor } = await import('../src/services/auth.ts');
    grantExtension(h.db, h.clock, resolveActor(h.db, h.clock, { authorization: `Bearer ${org}` }, {}), 'evt_demo_open', { team_id: team.id, until, reason: 'power cut' });
    assert.equal((await call(h.base, 'PATCH', `/api/projects/${id}`, pat, { summary: 'with extension' })).status, 200);
    const ada = await tokenFor(h.base, 'ada@glassbox.local');
    assert.equal((await call(h.base, 'PATCH', '/api/projects/prj_demo_0', ada, { summary: 'no extension' })).status, 403, 'other teams stay closed');
  } finally { await h.close(); }
});

test('judge -> publish -> scores lock; public results never expose per-judge scores', async () => {
  const h = await startSeeded();
  try {
    const org = await tokenFor(h.base, 'organizer@glassbox.local');
    assert.equal((await call(h.base, 'GET', '/api/events/evt_demo_judging/results')).status, 403, 'unpublished results are not public');
    const j = await tokenFor(h.base, 'judge1@glassbox.local');
    const q = (await call(h.base, 'GET', '/api/events/evt_demo_judging/queue', j)).data.queue;
    assert.ok(q.length > 0);
    for (const item of q) assert.equal((await call(h.base, 'PUT', `/api/events/evt_demo_judging/scores/${item.project_id}`, j, { impact: 4, execution: 3, presentation: 5, comment: 'ok' })).status, 200);
    const prog = await call(h.base, 'GET', '/api/events/evt_demo_judging/progress', org);
    assert.ok(prog.data.scored >= q.length);
    const pub = await call(h.base, 'POST', '/api/events/evt_demo_judging/publish', org);
    assert.equal(pub.status, 200);
    assert.match(pub.data.payload_hash, /^[0-9a-f]{64}$/);
    const res = await call(h.base, 'GET', '/api/events/evt_demo_judging/results');
    assert.equal(res.status, 200);
    assert.ok(!/usr_demo_judge/.test(res.text), 'no judge ids in public results');
    assert.ok(res.data.ranking.every((r: { rank: number; raw_rank: number }) => r.rank >= 1 && r.raw_rank >= 1));
    const locked = await call(h.base, 'PUT', `/api/events/evt_demo_judging/scores/${q[0].project_id}`, j, { impact: 1, execution: 1, presentation: 1 });
    assert.equal(locked.status, 403);
    assert.equal(locked.data.error.code, 'results_published');
  } finally { await h.close(); }
});

test('audit log is hash-chained and the database refuses tampering', async () => {
  const h = await startSeeded();
  try {
    const chain = verifyAuditChain(h.db);
    assert.ok(chain.ok);
    assert.ok(chain.entries >= 3, `entries ${chain.entries}`);
    assert.throws(() => run(h.db, "UPDATE audit_log SET action = 'x' WHERE seq = 1"));
    assert.throws(() => run(h.db, 'DELETE FROM audit_log WHERE seq = 1'));
    const v = await call(h.base, 'GET', '/api/audit/verify', T.organizer);
    assert.ok([200, 403].includes(v.status));
  } finally { await h.close(); }
});
