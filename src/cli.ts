import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, get } from './db/index.ts';
import { systemClock } from './util.ts';
import { seed } from './seed.ts';
import { importBundle, exportEvent } from './services/importer.ts';
import { verifyAuditChain } from './services/audit.ts';
import { getUser, type Actor } from './services/auth.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const db = openDb(process.env.GLASSBOX_DB ?? join(root, 'data', 'glassbox.db'));
const [cmd, ...args] = process.argv.slice(2);

function organizer(): Actor {
  const row = get<{ id: string }>(db, "SELECT id FROM users WHERE platform_role IN ('admin','organizer') ORDER BY platform_role = 'admin' DESC, created_at LIMIT 1");
  if (!row) throw new Error('No admin/organizer account yet. Run `seed` first.');
  return { user: getUser(db, row.id)!, via: 'api', csrf: null };
}

switch (cmd) {
  case 'seed': {
    const rep = seed(db, systemClock, { fixturesPath: args[0] ?? join(root, 'data', 'fixtures.json'), adminPassword: process.env.GLASSBOX_ADMIN_PASSWORD, demoTokens: process.env.GLASSBOX_DEMO_TOKENS !== 'off' });
    console.log(rep.seeded ? `Seeded events: ${rep.events.join(', ')}` : 'Database already has users; nothing to do.');
    for (const a of rep.accounts) console.log(`  ${a.email.padEnd(32)} ${a.password.padEnd(16)} ${a.role}`);
    break;
  }
  case 'import': {
    if (!args[0]) throw new Error('usage: cli.ts import <bundle.json>');
    console.log(JSON.stringify(importBundle(db, systemClock, organizer(), JSON.parse(readFileSync(args[0], 'utf8'))), null, 2));
    break;
  }
  case 'export': {
    if (!args[0]) throw new Error('usage: cli.ts export <event-id> [out.json]');
    const out = JSON.stringify(exportEvent(db, organizer(), args[0]), null, 2);
    if (args[1]) writeFileSync(args[1], out); else console.log(out);
    break;
  }
  case 'verify-audit': {
    const r = verifyAuditChain(db);
    console.log(r.ok ? `Audit chain intact: ${r.entries} entries, head ${r.head}` : `Audit chain BROKEN at entry #${r.brokenAt}`);
    process.exitCode = r.ok ? 0 : 1;
    break;
  }
  default:
    console.log('usage: node src/cli.ts <seed [fixtures.json] | import <file> | export <event-id> [out] | verify-audit>');
    process.exitCode = cmd ? 1 : 0;
}
db.close();
