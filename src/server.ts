import { createServer } from 'node:http';
import { join, dirname } from 'node:path';
import { openDb } from './db/index.ts';
import { systemClock } from './util.ts';
import { createApp } from './app.ts';
import { seed } from './seed.ts';

const root = join(dirname(new URL(import.meta.url).pathname), '..');
const dbPath = process.env.GLASSBOX_DB ?? join(root, 'data', 'glassbox.db');
const port = Number(process.env.PORT ?? 8080);
const host = process.env.HOST ?? '0.0.0.0';

const db = openDb(dbPath);
if ((process.env.GLASSBOX_SEED ?? 'auto') !== 'off') {
  const rep = seed(db, systemClock, {
    fixturesPath: process.env.GLASSBOX_FIXTURES ?? join(root, 'data', 'fixtures.json'),
    adminPassword: process.env.GLASSBOX_ADMIN_PASSWORD,
    demoTokens: process.env.GLASSBOX_DEMO_TOKENS !== 'off',
  });
  if (rep.seeded) {
    console.log(`Seeded ${rep.events.length} events. Demo accounts:`);
    for (const a of rep.accounts) console.log(`  ${a.email.padEnd(32)} ${a.password.padEnd(16)} ${a.role}`);
  }
}

const server = createServer(createApp({ db, clock: systemClock, secureCookies: process.env.GLASSBOX_SECURE_COOKIES === '1' }));
server.listen(port, host, () => console.log(`Glassbox listening on http://${host === '0.0.0.0' ? 'localhost' : host}:${port} (db: ${dbPath})`));

const stop = () => server.close(() => { db.close(); process.exit(0); });
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
