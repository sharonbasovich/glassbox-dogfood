import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, type Db } from '../src/db/index.ts';
import { createApp } from '../src/app.ts';
import { seed } from '../src/seed.ts';
import type { Clock } from '../src/util.ts';

export const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'fixtures.json');

export class FakeClock implements Clock {
  t: number;
  constructor(isoTime: string) { this.t = Date.parse(isoTime); }
  now() { return new Date(this.t); }
  set(isoTime: string) { this.t = Date.parse(isoTime); }
  advanceHours(h: number) { this.t += h * 3600_000; }
}

export interface Harness { db: Db; clock: FakeClock; base: string; server: Server; close(): Promise<void> }

export async function startSeeded(now = '2026-09-26T12:00:00Z'): Promise<Harness> {
  const db = openDb(':memory:');
  const clock = new FakeClock(now);
  seed(db, clock, { fixturesPath: FIXTURES });
  const server = createServer(createApp({ db, clock }));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { db, clock, base, server, close: () => new Promise((r) => { server.closeAllConnections(); server.close(() => r()); }) };
}

export async function call(base: string, method: string, path: string, token?: string, body?: unknown) {
  const res = await fetch(base + path, {
    method,
    redirect: 'manual',
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data: any = null;
  try { data = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, text, data, headers: res.headers };
}

export async function tokenFor(base: string, email: string, password = 'glassbox-demo'): Promise<string> {
  const r = await call(base, 'POST', '/api/login', undefined, { email, password });
  if (r.status !== 200) throw new Error(`login failed for ${email}: ${r.text}`);
  return r.data.token as string;
}
