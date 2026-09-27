import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startSeeded, call, type Harness } from './helpers.ts';
import { CHECKER_TOKENS as T } from '../src/seed.ts';

let h: Harness;
before(async () => { h = await startSeeded(); });
after(async () => { await h.close(); });

async function login(email: string, next?: string) {
  const body = new URLSearchParams({ email, password: 'glassbox-demo', ...(next !== undefined ? { next } : {}) });
  const r = await fetch(h.base + '/login', { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body });
  return { location: r.headers.get('location'), cookie: r.headers.get('set-cookie')!.split(';')[0]! };
}

async function getPage(path: string, cookie: string) {
  const r = await fetch(h.base + path, { headers: { cookie }, redirect: 'manual' });
  return { status: r.status, text: await r.text() };
}

test('login next redirect rejects off-site, backslash and control-char targets', async () => {
  for (const next of ['//evil.example', '//evil.example/x', '/\\evil.example/x', '/\\/evil.example', '/%0d', '/a\r\nb', '/a\tb', 'https://evil.example/']) {
    const { location } = await login('pat@glassbox.local', next);
    assert.equal(location, next === '/%0d' ? '/%0d' : '/', `next=${JSON.stringify(next)}`);
  }
  assert.equal((await login('pat@glassbox.local', '/projects?q=a')).location, '/projects?q=a');
});

test('new event form offers tracks, prizes and a Create event action; setup keeps Save settings', async () => {
  const { cookie } = await login('organizer@glassbox.local');
  const created = await getPage('/events/new', cookie);
  assert.equal(created.status, 200);
  assert.match(created.text, /name="tracks"/);
  assert.match(created.text, /name="prizes"/);
  assert.match(created.text, /Create event<\/button>/);
  assert.doesNotMatch(created.text, /Save settings/);
  const setup = await getPage('/e/demo-jam/manage/setup', cookie);
  assert.match(setup.text, /Save settings<\/button>/);
});

test('judge score page becomes read-only once results are published', async () => {
  const { cookie } = await login('judge1@glassbox.local');
  const queue = await getPage('/e/spring-showcase/judge', cookie);
  const pid = queue.text.match(/judge\/(prj_show_\d+)/)![1]!;
  const before = await getPage(`/e/spring-showcase/judge/${pid}`, cookie);
  assert.match(before.text, /(Update|Save) score/);
  assert.doesNotMatch(before.text, /scores are locked/);
  assert.doesNotMatch(before.text, /weight \d+% · </, 'no dangling separator for empty descriptions');
  const pub = await call(h.base, 'POST', '/api/events/evt_demo_judging/publish', T.organizer);
  assert.equal(pub.status, 200);
  const after = await getPage(`/e/spring-showcase/judge/${pid}`, cookie);
  assert.match(after.text, /scores are locked/);
  assert.match(after.text, /<fieldset disabled/);
  assert.doesNotMatch(after.text, /(Update|Save) score/);
  assert.doesNotMatch(after.text, /Recuse from this project/);
});

test('error pages keep the signed-in header', async () => {
  const { cookie } = await login('judge1@glassbox.local');
  const r = await getPage('/e/sample-hack-2026/judge/prj_01', cookie);
  assert.ok(r.status >= 400);
  assert.match(r.text, /Sign out/);
  assert.doesNotMatch(r.text, /Create account/);
});

test('primary navigation stays visible on narrow screens', async () => {
  const css = await (await fetch(h.base + '/static/app.css')).text();
  const mobile = css.slice(css.indexOf('@media(max-width:800px)'));
  assert.doesNotMatch(mobile, /\.bar nav\{display:none/);
});
