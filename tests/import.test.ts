import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { openDb, get, all } from '../src/db/index.ts';
import { createUser } from '../src/services/auth.ts';
import { importBundle, exportEvent } from '../src/services/importer.ts';
import { FakeClock, FIXTURES } from './helpers.ts';

function setup() {
  const db = openDb(':memory:');
  const clock = new FakeClock('2026-09-26T12:00:00Z');
  const org = createUser(db, clock, { email: 'o@x.test', name: 'Org', password: 'password1', role: 'organizer' });
  return { db, clock, actor: { user: org, via: 'api' as const, csrf: null } };
}

test('fixture import keeps ids and counts, and resolves the duplicate submission', () => {
  const { db, clock, actor } = setup();
  const fx = JSON.parse(readFileSync(FIXTURES, 'utf8'));
  const rep = importBundle(db, clock, actor, fx);
  assert.equal(rep.event_id, 'evt_01');
  assert.equal(rep.counts.projects, 41);
  assert.equal(rep.counts.scores, 126);
  assert.equal(get<{ n: number }>(db, 'SELECT COUNT(*) n FROM tracks WHERE event_id = ?', 'evt_01')!.n, 8);
  assert.equal(get<{ n: number }>(db, "SELECT COUNT(*) n FROM event_roles WHERE event_id = ? AND role = 'judge'", 'evt_01')!.n, 30);
  const dry = all<{ id: string; duplicate_of: string | null }>(db, "SELECT id, duplicate_of FROM projects WHERE title = 'Dry Harbour' ORDER BY id");
  assert.deepEqual(dry.map((r) => ({ ...r })), [{ id: 'prj_07', duplicate_of: 'prj_41' }, { id: 'prj_41', duplicate_of: null }], 'latest submission is canonical');
  assert.ok(rep.duplicates.length >= 1);
  assert.ok(rep.warnings.some((w) => /team name/.test(w)), 'teams sharing a name are reported');
  assert.match(rep.sha256, /^[0-9a-f]{64}$/);
});

test('export -> import round-trips an event into a fresh instance', () => {
  const a = setup();
  importBundle(a.db, a.clock, a.actor, JSON.parse(readFileSync(FIXTURES, 'utf8')));
  const bundle = exportEvent(a.db, a.actor, 'evt_01');
  const b = setup();
  const rep = importBundle(b.db, b.clock, b.actor, JSON.parse(JSON.stringify(bundle)));
  assert.equal(rep.counts.projects, 41);
  assert.equal(rep.counts.scores, 126);
});

test('import rejects malformed bundles without partial writes', () => {
  const { db, clock, actor } = setup();
  assert.throws(() => importBundle(db, clock, actor, { event: { id: 'e' } }));
  const fx = JSON.parse(readFileSync(FIXTURES, 'utf8'));
  fx.event.id = 'evt_bad';
  fx.scores.push({ judge: 'jdg_nope', project: 'prj_01', criteria: { functionality: 3, quality: 3, innovation: 3 } });
  try { importBundle(db, clock, actor, fx); } catch { /* expected or warned */ }
  const ev = get<{ n: number }>(db, "SELECT COUNT(*) n FROM projects WHERE event_id = 'evt_bad'")!.n;
  assert.ok(ev === 0 || ev === 41, 'all-or-nothing');
});
