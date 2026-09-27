/**
 * Migration in and out. The input format is the DOGFOOD fixtures.json shape
 * (event, tracks, judges, teams, projects, scores) with optional extensions
 * (criteria, assignments, prizes). exportEvent() writes the same shape, so
 * export -> import round-trips an event between two Glassbox instances.
 */
import { type Db, all, get, run, tx } from '../db/index.ts';
import { newId, randomToken, sha256, badRequest, forbidden, iso, type Clock } from '../util.ts';
import type { Actor } from './auth.ts';
import { requireOrganizer, requireUser, canCreateEvents } from './authz.ts';
import { audit } from './audit.ts';
import { criteria as loadCriteria, getEvent, prizes as loadPrizes, tracks as loadTracks } from './events.ts';


export interface Bundle {
  format?: string;
  event: { id: string; name: string; submissions_close: string; submissions_open?: string; judging_close?: string | null; slug?: string; tagline?: string; description?: string; reviews_per_project?: number; max_team_size?: number };
  tracks: Array<{ id: string; name: string; description?: string }>;
  judges: Array<{ id: string; name: string; email: string; tracks?: string[] }>;
  teams: Array<{ id: string; name: string; members: string[] }>;
  projects: Array<{ id: string; team: string; track?: string | null; title: string; summary?: string; description?: string; repo_url?: string; demo_url?: string; submitted_at?: string | null; duplicate_of?: string | null }>;
  scores: Array<{ judge: string; project: string; criteria: Record<string, number>; comment?: string; updated_at?: string }>;
  criteria?: Array<{ key: string; name?: string; description?: string; weight: number; scale_min?: number; scale_max?: number }>;
  assignments?: Array<{ judge: string; project: string }>;
  prizes?: Array<{ name: string; description?: string; track?: string | null }>;
}

export interface ImportReport {
  event_id: string;
  counts: Record<string, number>;
  duplicates: Array<{ duplicate: string; canonical: string; reason: string }>;
  warnings: string[];
  remapped_ids: number;
  sha256: string;
}

const normTitle = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

function validate(b: unknown): asserts b is Bundle {
  const x = b as Partial<Bundle> | null;
  if (!x || typeof x !== 'object' || !x.event || !Array.isArray(x.projects) || !Array.isArray(x.teams)) throw badRequest('Not a fixtures bundle: expected event, teams and projects.', 'bad_bundle');
  if (!x.event.id || !x.event.name || !x.event.submissions_close || Number.isNaN(Date.parse(x.event.submissions_close))) throw badRequest('event.id, event.name and an ISO event.submissions_close are required.', 'bad_bundle');
  for (const k of ['tracks', 'judges', 'scores'] as const) if (x[k] !== undefined && !Array.isArray(x[k])) throw badRequest(`${k} must be an array.`, 'bad_bundle');
}

/**
 * Imports a bundle as a new event. Historical timestamps are preserved (the
 * importer does not go through the live deadline check; the import itself is
 * audited). Ids are kept when free, otherwise remapped.
 */
export function importBundle(db: Db, clock: Clock, actor: Actor, input: unknown, opts: { organizerId?: string } = {}): ImportReport {
  if (actor.user && !canCreateEvents(actor)) throw forbidden('Your account cannot create events.', 'cannot_create_events');
  validate(input);
  const b: Bundle = { ...input, tracks: input.tracks ?? [], judges: input.judges ?? [], scores: input.scores ?? [] };
  const now = iso(clock.now());
  const warnings: string[] = [];
  let remapped = 0;
  const taken = (table: string, id: string) => !!get(db, `SELECT 1 FROM ${table} WHERE id = ?`, id);
  const maps = { track: new Map<string, string>(), judge: new Map<string, string>(), team: new Map<string, string>(), project: new Map<string, string>() };
  const keep = (table: string, prefix: string, id: string) => {
    if (/^[A-Za-z0-9_-]{1,64}$/.test(id) && !taken(table, id)) return id;
    remapped++;
    return newId(prefix);
  };

  return tx(db, () => {
    const eventId = keep('events', 'evt', b.event.id);
    const close = new Date(b.event.submissions_close).toISOString();
    const firstSubmit = b.projects.map((p) => p.submitted_at).filter((s): s is string => !!s).sort()[0];
    const open = b.event.submissions_open ? new Date(b.event.submissions_open).toISOString()
      : iso(new Date(Math.min(Date.parse(close) - 72 * 3600_000, firstSubmit ? Date.parse(firstSubmit) - 3600_000 : Infinity)));
    let slug = (b.event.slug || b.event.name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'event';
    for (let i = 2; get(db, 'SELECT 1 FROM events WHERE slug = ?', slug); i++) slug = `${slug.replace(/-\d+$/, '')}-${i}`;
    run(
      db,
      `INSERT INTO events (id, slug, name, tagline, description, submissions_open_at, submissions_close_at, judging_close_at, max_team_size, reviews_per_project, source_ref, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      eventId, slug, b.event.name, b.event.tagline ?? '', b.event.description ?? '', open, close, b.event.judging_close ?? null,
      Math.max(4, b.event.max_team_size ?? Math.max(...b.teams.map((t) => t.members.length), 1)), b.event.reviews_per_project ?? 3,
      `import:${b.event.id}`, actor.user?.id ?? null, now,
    );
    const organizer = opts.organizerId ?? actor.user?.id;
    if (organizer) run(db, "INSERT OR IGNORE INTO event_roles (event_id, user_id, role, created_at) VALUES (?, ?, 'organizer', ?)", eventId, organizer, now);

    b.tracks.forEach((t, i) => {
      const id = keep('tracks', 'trk', t.id);
      maps.track.set(t.id, id);
      run(db, 'INSERT INTO tracks (id, event_id, name, description, position, source_ref) VALUES (?, ?, ?, ?, ?, ?)', id, eventId, t.name, t.description ?? '', i, t.id);
    });
    (b.prizes ?? []).forEach((p, i) => run(db, 'INSERT INTO prizes (id, event_id, track_id, name, description, position) VALUES (?, ?, ?, ?, ?, ?)', newId('prz'), eventId, p.track ? maps.track.get(p.track) ?? null : null, p.name, p.description ?? '', i));

    const userByEmail = (email: string, name: string, preferredId?: string) => {
      const e = email.trim().toLowerCase();
      const found = get<{ id: string }>(db, 'SELECT id FROM users WHERE email = ?', e);
      if (found) return found.id;
      const id = preferredId && !taken('users', preferredId) ? preferredId : newId('usr');
      run(db, 'INSERT INTO users (id, email, name, created_at) VALUES (?, ?, ?, ?)', id, e, name, now);
      return id;
    };

    for (const j of b.judges) {
      const uid = userByEmail(j.email, j.name, j.id);
      if (uid !== j.id) remapped++;
      maps.judge.set(j.id, uid);
      run(db, "INSERT OR IGNORE INTO event_roles (event_id, user_id, role, created_at) VALUES (?, ?, 'judge', ?)", eventId, uid, now);
      for (const t of j.tracks ?? []) {
        const tid = maps.track.get(t);
        if (tid) run(db, 'INSERT OR IGNORE INTO judge_tracks (event_id, judge_id, track_id) VALUES (?, ?, ?)', eventId, uid, tid);
        else warnings.push(`judge ${j.id} references unknown track ${t}`);
      }
    }

    const judgeIds = new Set(maps.judge.values());
    for (const t of b.teams) {
      const id = keep('teams', 'tm', t.id);
      maps.team.set(t.id, id);
      let name = t.name;
      if (get(db, 'SELECT 1 FROM teams WHERE event_id = ? AND name = ? COLLATE NOCASE', eventId, name)) {
        name = `${t.name} (${t.id})`;
        warnings.push(`team name "${t.name}" is used by more than one team; ${t.id} imported as "${name}"`);
      }
      run(db, 'INSERT INTO teams (id, event_id, name, invite_code, created_at, source_ref) VALUES (?, ?, ?, ?, ?, ?)', id, eventId, name, randomToken('inv', 12), now, t.id);
      t.members.forEach((email, i) => {
        const uid = userByEmail(email, email.split('@')[0] ?? email);
        if (judgeIds.has(uid)) {
          warnings.push(`${email} is both a judge and a member of ${t.id}; kept as judge only`);
          return;
        }
        if (get(db, 'SELECT 1 FROM team_members WHERE event_id = ? AND user_id = ?', eventId, uid)) {
          warnings.push(`${email} appears in more than one team; kept in the first`);
          return;
        }
        run(db, 'INSERT INTO team_members (team_id, event_id, user_id, role, joined_at) VALUES (?, ?, ?, ?, ?)', id, eventId, uid, i === 0 ? 'owner' : 'member', now);
        run(db, "INSERT OR IGNORE INTO event_roles (event_id, user_id, role, created_at) VALUES (?, ?, 'participant', ?)", eventId, uid, now);
      });
    }

    // Duplicate detection: a team with several entries, or entries sharing a
    // normalised title or repo. The latest submission before the deadline is
    // treated as the team's final version (it supersedes earlier ones).
    const duplicates: ImportReport['duplicates'] = [];
    const canonicalOf = new Map<string, string>();
    const groups = new Map<string, Bundle['projects']>();
    for (const p of b.projects) groups.set(p.team, [...(groups.get(p.team) ?? []), p]);
    for (const list of groups.values()) {
      if (list.length < 2) continue;
      const sorted = [...list].sort((x, y) => (y.submitted_at ?? '').localeCompare(x.submitted_at ?? ''));
      const canon = sorted[0]!;
      for (const d of sorted.slice(1)) {
        canonicalOf.set(d.id, canon.id);
        const reason = normTitle(d.title) === normTitle(canon.title) ? 'same team, same title' : d.repo_url && d.repo_url === canon.repo_url ? 'same team, same repo' : 'same team, second entry';
        duplicates.push({ duplicate: d.id, canonical: canon.id, reason });
      }
    }
    const byTitle = new Map<string, string>();
    for (const p of b.projects) {
      const key = normTitle(p.title);
      const other = byTitle.get(key);
      if (other && !canonicalOf.has(p.id) && canonicalOf.get(other) !== p.id && b.projects.find((q) => q.id === other)?.team !== p.team) warnings.push(`projects ${other} and ${p.id} share the title "${p.title}" across different teams`);
      byTitle.set(key, p.id);
    }

    const ordered = [...b.projects].sort((x, y) => Number(canonicalOf.has(x.id)) - Number(canonicalOf.has(y.id)));
    for (const p of ordered) {
      const team = maps.team.get(p.team);
      if (!team) {
        warnings.push(`project ${p.id} references unknown team ${p.team}; skipped`);
        continue;
      }
      const id = keep('projects', 'prj', p.id);
      maps.project.set(p.id, id);
      const late = p.submitted_at && p.submitted_at > close;
      if (late) warnings.push(`project ${p.id} was submitted after the deadline (${p.submitted_at}); imported as draft`);
      const submitted = !!p.submitted_at && !late;
      run(
        db,
        `INSERT INTO projects (id, event_id, team_id, track_id, title, summary, description, repo_url, demo_url, status, submitted_at, created_at, updated_at, source_ref, duplicate_of)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id, eventId, team, p.track ? maps.track.get(p.track) ?? null : null, p.title, p.summary ?? '', p.description ?? '', p.repo_url ?? '', p.demo_url ?? '',
        submitted ? 'submitted' : 'draft', submitted ? p.submitted_at! : null, p.submitted_at ?? now, p.submitted_at ?? now, p.id,
        canonicalOf.has(p.id) ? maps.project.get(canonicalOf.get(p.id)!) ?? null : null,
      );
    }

    // Rubric: explicit criteria, else inferred from score keys with equal weights.
    const keys = b.criteria?.map((c) => c.key) ?? [...new Set(b.scores.flatMap((s) => Object.keys(s.criteria)))];
    const critId = new Map<string, string>();
    keys.forEach((key, i) => {
      const spec = b.criteria?.find((c) => c.key === key);
      const id = newId('crt');
      critId.set(key, id);
      const name = spec?.name ?? key.charAt(0).toUpperCase() + key.slice(1);
      run(db, 'INSERT INTO criteria (id, event_id, key, name, description, weight, scale_min, scale_max, position) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', id, eventId, key, name, spec?.description ?? '', spec?.weight ?? 1, spec?.scale_min ?? 1, spec?.scale_max ?? 5, i);
    });

    const assign = (judge: string, project: string) =>
      run(db, "INSERT OR IGNORE INTO assignments (event_id, judge_id, project_id, source, assigned_at) VALUES (?, ?, ?, 'import', ?)", eventId, judge, project, now);
    for (const a of b.assignments ?? []) {
      const j = maps.judge.get(a.judge);
      const p = maps.project.get(a.project);
      if (j && p) assign(j, p);
    }
    let scoreCount = 0;
    for (const s of b.scores) {
      const j = maps.judge.get(s.judge);
      const p = maps.project.get(s.project);
      if (!j || !p) {
        warnings.push(`score ${s.judge}/${s.project} references an unknown judge or project; skipped`);
        continue;
      }
      if (get(db, 'SELECT 1 FROM scores WHERE judge_id = ? AND project_id = ?', j, p)) {
        warnings.push(`duplicate score ${s.judge}/${s.project}; kept the first`);
        continue;
      }
      assign(j, p);
      const id = newId('scr');
      run(db, 'INSERT INTO scores (id, event_id, judge_id, project_id, comment, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)', id, eventId, j, p, s.comment ?? '', s.updated_at ?? close, s.updated_at ?? close);
      for (const [k, v] of Object.entries(s.criteria)) {
        const cid = critId.get(k);
        if (cid && Number.isFinite(v)) run(db, 'INSERT INTO score_values (score_id, criterion_id, value) VALUES (?, ?, ?)', id, cid, v);
      }
      scoreCount++;
    }

    const report: ImportReport = {
      event_id: eventId,
      counts: { tracks: maps.track.size, judges: maps.judge.size, teams: maps.team.size, projects: maps.project.size, scores: scoreCount, criteria: keys.length },
      duplicates,
      warnings,
      remapped_ids: remapped,
      sha256: sha256(JSON.stringify(input)),
    };
    audit(db, { actor, eventId, action: 'event.import', subjectType: 'event', subjectId: eventId, detail: { ...report, warnings: warnings.length }, at: now });
    return report;
  });
}

/** Full event export in the import format (organizers only). */
export function exportEvent(db: Db, actor: Actor, eventId: string): Bundle {
  requireUser(actor);
  requireOrganizer(db, actor, eventId);
  const e = getEvent(db, eventId)!;
  const rubric = loadCriteria(db, eventId);
  const byCrit = new Map(rubric.map((c) => [c.id, c.key]));
  const tracks = loadTracks(db, eventId);
  return {
    format: 'glassbox-bundle/1 (DOGFOOD fixtures compatible)',
    event: { id: e.id, name: e.name, slug: e.slug, tagline: e.tagline, description: e.description, submissions_open: e.submissions_open_at, submissions_close: e.submissions_close_at, judging_close: e.judging_close_at, reviews_per_project: e.reviews_per_project, max_team_size: e.max_team_size },
    tracks: tracks.map((t) => ({ id: t.id, name: t.name, description: t.description })),
    prizes: loadPrizes(db, eventId).map((p) => ({ name: p.name, description: p.description, track: p.track_id })),
    criteria: rubric.map((c) => ({ key: c.key, name: c.name, description: c.description, weight: c.weight, scale_min: c.scale_min, scale_max: c.scale_max })),
    judges: all<{ id: string; name: string; email: string }>(db, "SELECT u.id, u.name, u.email FROM event_roles r JOIN users u ON u.id = r.user_id WHERE r.event_id = ? AND r.role = 'judge' ORDER BY u.id", eventId).map((j) => ({
      ...j,
      tracks: all<{ track_id: string }>(db, 'SELECT track_id FROM judge_tracks WHERE event_id = ? AND judge_id = ?', eventId, j.id).map((t) => t.track_id),
    })),
    teams: all<{ id: string; name: string }>(db, 'SELECT id, name FROM teams WHERE event_id = ? ORDER BY id', eventId).map((t) => ({
      ...t,
      members: all<{ email: string }>(db, 'SELECT u.email FROM team_members m JOIN users u ON u.id = m.user_id WHERE m.team_id = ? ORDER BY m.role DESC, m.joined_at', t.id).map((m) => m.email),
    })),
    projects: all<Bundle['projects'][number] & { track_id: string | null; team_id: string }>(db, 'SELECT * FROM projects WHERE event_id = ? ORDER BY id', eventId).map((p) => ({
      id: p.id, team: p.team_id, track: p.track_id, title: p.title, summary: p.summary, description: p.description, repo_url: p.repo_url, demo_url: p.demo_url, submitted_at: p.submitted_at, duplicate_of: p.duplicate_of,
    })),
    assignments: all<{ judge: string; project: string }>(db, 'SELECT judge_id judge, project_id project FROM assignments WHERE event_id = ? ORDER BY judge_id, project_id', eventId),
    scores: all<{ id: string; judge_id: string; project_id: string; comment: string; updated_at: string }>(db, 'SELECT id, judge_id, project_id, comment, updated_at FROM scores WHERE event_id = ? ORDER BY project_id, judge_id', eventId).map((s) => ({
      judge: s.judge_id,
      project: s.project_id,
      comment: s.comment,
      updated_at: s.updated_at,
      criteria: Object.fromEntries(all<{ criterion_id: string; value: number }>(db, 'SELECT criterion_id, value FROM score_values WHERE score_id = ?', s.id).map((v) => [byCrit.get(v.criterion_id) ?? v.criterion_id, v.value])),
    })),
  };
}
