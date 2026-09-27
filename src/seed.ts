import { readFileSync } from 'node:fs';
import { type Db, get, run, tx } from './db/index.ts';
import { iso, type Clock } from './util.ts';
import { createSession, createUser, hashPassword, type Actor, type User } from './services/auth.ts';
import { importBundle, type Bundle } from './services/importer.ts';
import { autoAssign } from './services/judging.ts';

export const DEMO_PASSWORD = 'glassbox-demo';

/** Fixed API tokens for the acceptance checker (.dogfood.toml). Disable with GLASSBOX_DEMO_TOKENS=off. */
export const CHECKER_TOKENS = {
  organizer: 'gbx_demo_organizer_7f2a9c41',
  judge_a: 'gbx_demo_judge_a_91bc3e07',
  judge_b: 'gbx_demo_judge_b_44de7a5d',
  participant: 'gbx_demo_participant_2e88f16b',
} as const;

export interface SeedOptions {
  fixturesPath: string;
  adminPassword?: string;
  demoTokens?: boolean;
}

export interface SeedReport {
  seeded: boolean;
  events: string[];
  accounts: Array<{ email: string; password: string; role: string }>;
}

const actorOf = (user: User): Actor => ({ user, via: 'api', csrf: null });

function setPassword(db: Db, email: string, password: string): string | undefined {
  const u = get<{ id: string }>(db, 'SELECT id FROM users WHERE email = ?', email);
  if (u) run(db, 'UPDATE users SET password_hash = ? WHERE id = ?', hashPassword(password), u.id);
  return u?.id;
}

const hoursFrom = (d: Date, h: number) => iso(new Date(d.getTime() + h * 3600_000));

/** Seeds an empty database: admin + organizer, the DOGFOOD fixture event and two demo events. Idempotent: does nothing if users exist. */
export function seed(db: Db, clock: Clock, opts: SeedOptions): SeedReport {
  if (get(db, 'SELECT 1 FROM users LIMIT 1')) return { seeded: false, events: [], accounts: [] };
  return tx(db, () => seedAll(db, clock, opts));
}

function seedAll(db: Db, clock: Clock, opts: SeedOptions): SeedReport {
  const now = clock.now();
  const adminPw = opts.adminPassword || DEMO_PASSWORD;
  const admin = createUser(db, clock, { email: 'admin@glassbox.local', name: 'Instance Admin', password: adminPw, role: 'admin' });
  const org = createUser(db, clock, { email: 'organizer@glassbox.local', name: 'Olivia Organizer', password: DEMO_PASSWORD, role: 'organizer' });
  const events: string[] = [];

  // 1. The official fixture event (closed; used by the acceptance checker).
  const fixtures = JSON.parse(readFileSync(opts.fixturesPath, 'utf8')) as Bundle;
  const fx = importBundle(db, clock, actorOf(org), fixtures);
  events.push(fx.event_id);
  const judgeA = fixtures.judges[0]!.email;
  const judgeB = fixtures.judges[1]!.email;
  const participant = fixtures.teams[0]!.members[0]!;
  const ids = { judge_a: setPassword(db, judgeA, DEMO_PASSWORD)!, judge_b: setPassword(db, judgeB, DEMO_PASSWORD)!, participant: setPassword(db, participant, DEMO_PASSWORD)! };

  // 2. An open demo event: create a team, submit, edit until the deadline.
  const people = ['Ada', 'Ben', 'Chen', 'Dana', 'Eli', 'Fatima', 'Goran', 'Hana', 'Ivan', 'Jun', 'Kemi', 'Lior'];
  const demoTeams = [
    ['Lantern Labs', 'Pocket Planner', 'Offline-first trip planner that syncs over Bluetooth.'],
    ['Quiet Circuit', 'Noise Map', 'Crowd-sourced noise pollution map for city councils.'],
    ['Byte Garden', 'Seed Swap', 'Neighbourhood seed library with QR check-out.'],
  ] as const;
  const open = importBundle(db, clock, actorOf(org), {
    event: { id: 'evt_demo_open', slug: 'demo-jam', name: 'Glassbox Demo Jam', tagline: 'Open now — make a team and submit a project.', description: 'A live demo event. Submissions are open for a week from when this instance was seeded.\n\nCreate an account, create a team (or join one with an invite link), save a draft and submit before the deadline.', submissions_open: hoursFrom(now, -2), submissions_close: hoursFrom(now, 24 * 7), judging_close: hoursFrom(now, 24 * 10), reviews_per_project: 2, max_team_size: 4 },
    tracks: [{ id: 'trk_demo_civic', name: 'Civic tech' }, { id: 'trk_demo_tools', name: 'Tools for makers' }],
    prizes: [{ name: 'Best overall' }, { name: 'Best civic project', track: 'trk_demo_civic' }],
    criteria: [{ key: 'impact', name: 'Impact', weight: 40, description: 'Would people use it?' }, { key: 'execution', name: 'Execution', weight: 40, description: 'Does it work, is it well built?' }, { key: 'presentation', name: 'Presentation', weight: 20, description: 'Is it clear what it does?' }],
    judges: [{ id: 'usr_demo_judge1', name: 'Jordan Judge', email: 'judge1@glassbox.local' }, { id: 'usr_demo_judge2', name: 'Riley Reviewer', email: 'judge2@glassbox.local' }],
    teams: demoTeams.map(([name], i) => ({ id: `tm_demo_${i}`, name, members: [`${people[i * 2]!.toLowerCase()}@glassbox.local`, `${people[i * 2 + 1]!.toLowerCase()}@glassbox.local`] })),
    projects: demoTeams.map(([, title, summary], i) => ({ id: `prj_demo_${i}`, team: `tm_demo_${i}`, track: i === 2 ? 'trk_demo_tools' : 'trk_demo_civic', title, summary, description: `${summary}\n\nBuilt during the Glassbox Demo Jam.`, repo_url: `https://example.org/demo/${i}`, submitted_at: i < 2 ? hoursFrom(now, -1) : null })),
    scores: [],
  });
  events.push(open.event_id);

  // 3. A demo event in judging: score as a judge, watch the dashboard, publish.
  const showcaseProjects = [
    ['Tidepool', 'Reef health from citizen photos.'], ['Stackwise', 'Explains a stack trace in plain words.'], ['Greenlight', 'Traffic signal timing simulator.'],
    ['Loomcast', 'Weather-aware knitting patterns.'], ['Sparrow', 'Tiny self-hosted status page.'], ['Kiln', 'Pottery firing logbook.'],
    ['Waypoint', 'Accessible indoor wayfinding.'], ['Ledgerly', 'Shared expenses for housemates.'],
  ] as const;
  const sJudges = [
    { id: 'usr_demo_judge1', name: 'Jordan Judge', email: 'judge1@glassbox.local' },
    { id: 'usr_demo_judge2', name: 'Riley Reviewer', email: 'judge2@glassbox.local' },
    { id: 'usr_demo_judge3', name: 'Sam Lenient', email: 'judge3@glassbox.local' },
    { id: 'usr_demo_judge4', name: 'Taylor Tough', email: 'judge4@glassbox.local' },
  ];
  const base = [4, 3, 5, 2, 4, 3, 5, 2];
  const scores: Bundle['scores'] = [];
  showcaseProjects.forEach((_, i) => {
    const j3 = { judge: 'usr_demo_judge3', project: `prj_show_${i}`, criteria: { impact: 5, execution: Math.min(5, base[i]! + 2), presentation: 5 }, comment: 'Loved it!', updated_at: hoursFrom(now, -5) };
    const j4 = { judge: 'usr_demo_judge4', project: `prj_show_${i}`, criteria: { impact: Math.max(1, base[i]! - 2), execution: Math.max(1, base[i]! - 1), presentation: 1 }, comment: 'Needs more polish.', updated_at: hoursFrom(now, -4) };
    const j2 = { judge: 'usr_demo_judge2', project: `prj_show_${i}`, criteria: { impact: base[i]!, execution: base[i]!, presentation: Math.max(1, base[i]! - 1) }, comment: '', updated_at: hoursFrom(now, -3) };
    if (i % 2 === 0) scores.push(j3); else scores.push(j4);
    if (i < 6) scores.push(j2);
  });
  const show = importBundle(db, clock, actorOf(org), {
    event: { id: 'evt_demo_judging', slug: 'spring-showcase', name: 'Spring Showcase', tagline: 'Submissions closed — judging in progress.', description: 'A demo event in the judging phase. Sign in as a judge to score, then as the organizer to compare raw and calibrated rankings and publish.', submissions_open: hoursFrom(now, -24 * 4), submissions_close: hoursFrom(now, -24), judging_close: hoursFrom(now, 24 * 6), reviews_per_project: 2, max_team_size: 4 },
    tracks: [{ id: 'trk_show_open', name: 'Open' }, { id: 'trk_show_impact', name: 'Social impact' }],
    prizes: [{ name: 'Best overall' }, { name: 'Social impact award', track: 'trk_show_impact' }],
    criteria: [{ key: 'impact', name: 'Impact', weight: 40 }, { key: 'execution', name: 'Execution', weight: 40 }, { key: 'presentation', name: 'Presentation', weight: 20 }],
    judges: sJudges,
    teams: showcaseProjects.map(([t], i) => ({ id: `tm_show_${i}`, name: `Team ${t}`, members: [`show${i}@glassbox.local`] })),
    projects: showcaseProjects.map(([title, summary], i) => ({ id: `prj_show_${i}`, team: `tm_show_${i}`, track: i % 3 === 0 ? 'trk_show_impact' : 'trk_show_open', title, summary, repo_url: `https://example.org/show/${i}`, submitted_at: hoursFrom(now, -30 - i) })),
    scores,
  });
  autoAssign(db, clock, actorOf(org), show.event_id);
  events.push(show.event_id);

  for (const email of ['judge1@glassbox.local', 'judge2@glassbox.local', 'judge3@glassbox.local', 'judge4@glassbox.local', 'ada@glassbox.local']) setPassword(db, email, DEMO_PASSWORD);
  createUser(db, clock, { email: 'pat@glassbox.local', name: 'Pat Participant', password: DEMO_PASSWORD });

  if (opts.demoTokens !== false) {
    createSession(db, clock, org.id, 'api', 'checker: organizer', CHECKER_TOKENS.organizer);
    createSession(db, clock, ids.judge_a, 'api', 'checker: judge_a', CHECKER_TOKENS.judge_a);
    createSession(db, clock, ids.judge_b, 'api', 'checker: judge_b', CHECKER_TOKENS.judge_b);
    createSession(db, clock, ids.participant, 'api', 'checker: participant', CHECKER_TOKENS.participant);
  }

  return {
    seeded: true,
    events,
    accounts: [
      { email: 'admin@glassbox.local', password: adminPw, role: 'admin' },
      { email: 'organizer@glassbox.local', password: DEMO_PASSWORD, role: 'organizer of all seeded events' },
      { email: 'judge1@glassbox.local', password: DEMO_PASSWORD, role: 'judge (Demo Jam, Spring Showcase)' },
      { email: 'pat@glassbox.local', password: DEMO_PASSWORD, role: 'participant without a team' },
      { email: judgeA, password: DEMO_PASSWORD, role: 'fixture judge_a' },
      { email: judgeB, password: DEMO_PASSWORD, role: 'fixture judge_b' },
      { email: participant, password: DEMO_PASSWORD, role: 'fixture participant (team tm_01)' },
    ],
  };
}
