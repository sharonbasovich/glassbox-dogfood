import { type Db, all, get, run, tx } from '../db/index.ts';
import { newId, str, badRequest, notFound, forbidden, conflict, iso, sha256, type Clock } from '../util.ts';
import { type Actor, type User, createClaimLink, ensureUser, getUser } from './auth.ts';
import { eventRoles, requireJudge, requireOrganizer, assertCanReadJudgeScores, judgedEventIds, requireUser } from './authz.ts';
import { audit } from './audit.ts';
import { type EventRow, criteria, getEvent, phase } from './events.ts';
import { getProject } from './projects.ts';

export interface JudgeRow { id: string; name: string; email: string; claimed: number; tracks: string; assigned: number; scored: number }

export function judges(db: Db, eventId: string): JudgeRow[] {
  return all<JudgeRow>(
    db,
    `SELECT u.id, u.name, u.email, (u.password_hash IS NOT NULL) claimed,
            COALESCE((SELECT group_concat(jt.track_id) FROM judge_tracks jt WHERE jt.event_id = r.event_id AND jt.judge_id = u.id), '') tracks,
            (SELECT COUNT(*) FROM assignments a WHERE a.event_id = r.event_id AND a.judge_id = u.id) assigned,
            (SELECT COUNT(*) FROM scores s WHERE s.event_id = r.event_id AND s.judge_id = u.id) scored
       FROM event_roles r JOIN users u ON u.id = r.user_id
      WHERE r.event_id = ? AND r.role = 'judge' ORDER BY u.name`,
    eventId,
  );
}

function trackList(input: Record<string, unknown>): string[] {
  const raw = input.tracks ?? input.track_ids;
  if (Array.isArray(raw)) return raw.map(String).filter(Boolean);
  return String(raw ?? '').split(',').map((s) => s.trim()).filter(Boolean);
}

/**
 * Invites a judge by email. Offline deployments have no mail server, so a new
 * account comes back with a one-time claim link the organizer passes on.
 */
export function inviteJudge(db: Db, clock: Clock, actor: Actor, eventId: string, input: Record<string, unknown>, opts: { userId?: string } = {}): { judge: User; claimLink: string | null } {
  requireOrganizer(db, actor, eventId);
  const email = str(input, 'email', { max: 254 });
  const name = str(input, 'name', { optional: true, max: 120 });
  const trackIds = trackList(input);
  for (const t of trackIds) if (!get(db, 'SELECT 1 FROM tracks WHERE id = ? AND event_id = ?', t, eventId)) throw badRequest(`Unknown track ${t}.`, 'validation');
  return tx(db, () => {
    const existing = get<{ id: string }>(db, 'SELECT id FROM users WHERE email = ?', email.toLowerCase());
    const { user, created } = existing
      ? { user: getUser(db, existing.id)!, created: false }
      : opts.userId
        ? (() => { run(db, 'INSERT INTO users (id, email, name, created_at) VALUES (?, ?, ?, ?)', opts.userId!, email.toLowerCase(), name || email, iso(clock.now())); return { user: getUser(db, opts.userId!)!, created: true }; })()
        : ensureUser(db, clock, email, name || undefined);
    const roles = eventRoles(db, user.id, eventId);
    if (roles.has('participant')) throw conflict(`${user.email} is a participant in this event and cannot judge it.`, 'participant_conflict');
    const now = iso(clock.now());
    run(db, "INSERT OR IGNORE INTO event_roles (event_id, user_id, role, created_at) VALUES (?, ?, 'judge', ?)", eventId, user.id, now);
    run(db, 'DELETE FROM judge_tracks WHERE event_id = ? AND judge_id = ?', eventId, user.id);
    for (const t of trackIds) run(db, 'INSERT INTO judge_tracks (event_id, judge_id, track_id) VALUES (?, ?, ?)', eventId, user.id, t);
    const claimLink = created ? `/claim/${createClaimLink(db, clock, user.id, actor.user?.id ?? null)}` : null;
    audit(db, { actor, eventId, action: 'judge.invite', subjectType: 'user', subjectId: user.id, detail: { email: user.email, tracks: trackIds, newAccount: created }, at: now });
    return { judge: user, claimLink };
  });
}

export function removeJudge(db: Db, clock: Clock, actor: Actor, eventId: string, judgeId: string): void {
  requireOrganizer(db, actor, eventId);
  if (get(db, 'SELECT 1 FROM scores WHERE event_id = ? AND judge_id = ?', eventId, judgeId)) throw conflict('This judge has submitted scores; remove is refused to keep the record intact.', 'judge_has_scores');
  tx(db, () => {
    run(db, 'DELETE FROM assignments WHERE event_id = ? AND judge_id = ?', eventId, judgeId);
    run(db, 'DELETE FROM judge_tracks WHERE event_id = ? AND judge_id = ?', eventId, judgeId);
    if (run(db, "DELETE FROM event_roles WHERE event_id = ? AND user_id = ? AND role = 'judge'", eventId, judgeId) === 0) throw notFound('Not a judge here.');
    audit(db, { actor, eventId, action: 'judge.remove', subjectType: 'user', subjectId: judgeId, at: iso(clock.now()) });
  });
}

interface Candidate { id: string; tracks: Set<string>; load: number; assigned: Set<string> }

/** Stable pseudo-random tie-breaker so auto-assignment is reproducible and auditable. */
const tiebreak = (seed: string) => parseInt(sha256(seed).slice(0, 8), 16);

/**
 * Greedy balanced assignment. For each project (fewest reviews first) pick
 * judges until it has `reviews_per_project`: prefer judges whose tracks
 * include the project's track, then the lowest current load, then a
 * deterministic hash. Conflicts of interest and existing pairs are skipped.
 * Returns what it did so the organizer can see it before and after.
 */
export function autoAssign(db: Db, clock: Clock, actor: Actor, eventId: string, opts: { maxPerJudge?: number } = {}): { created: number; shortfall: Array<{ projectId: string; missing: number }>; offTrack: number } {
  requireOrganizer(db, actor, eventId);
  const event = getEvent(db, eventId)!;
  const projects = all<{ id: string; team_id: string; track_id: string | null; n: number }>(
    db,
    `SELECT p.id, p.team_id, p.track_id, (SELECT COUNT(*) FROM assignments a WHERE a.project_id = p.id) n
       FROM projects p WHERE p.event_id = ? AND p.status = 'submitted' AND p.duplicate_of IS NULL ORDER BY n, p.id`,
    eventId,
  );
  const pool: Candidate[] = judges(db, eventId).map((j) => ({
    id: j.id,
    tracks: new Set(j.tracks ? j.tracks.split(',') : []),
    load: j.assigned,
    assigned: new Set(all<{ project_id: string }>(db, 'SELECT project_id FROM assignments WHERE judge_id = ? AND event_id = ?', j.id, eventId).map((r) => r.project_id)),
  }));
  if (pool.length === 0) throw conflict('Invite judges before assigning.', 'no_judges');
  const conflicts = new Set(all<{ judge_id: string; team_id: string }>(db, 'SELECT judge_id, team_id FROM conflicts WHERE event_id = ?', eventId).map((c) => `${c.judge_id}|${c.team_id}`));
  const cap = opts.maxPerJudge ?? Infinity;
  const now = iso(clock.now());
  let created = 0;
  let offTrack = 0;
  const shortfall: Array<{ projectId: string; missing: number }> = [];
  tx(db, () => {
    for (const p of projects) {
      let need = event.reviews_per_project - p.n;
      while (need > 0) {
        const eligible = pool.filter((j) => !j.assigned.has(p.id) && !conflicts.has(`${j.id}|${p.team_id}`) && j.load < cap);
        if (eligible.length === 0) break;
        eligible.sort(
          (a, b) =>
            Number(p.track_id ? b.tracks.has(p.track_id) : 0) - Number(p.track_id ? a.tracks.has(p.track_id) : 0) ||
            a.load - b.load ||
            tiebreak(`${eventId}|${p.id}|${a.id}`) - tiebreak(`${eventId}|${p.id}|${b.id}`),
        );
        const pick = eligible[0]!;
        if (p.track_id && !pick.tracks.has(p.track_id)) offTrack++;
        run(db, "INSERT INTO assignments (event_id, judge_id, project_id, source, assigned_by, assigned_at) VALUES (?, ?, ?, 'auto', ?, ?)", eventId, pick.id, p.id, actor.user?.id ?? null, now);
        pick.assigned.add(p.id);
        pick.load++;
        created++;
        need--;
      }
      if (need > 0) shortfall.push({ projectId: p.id, missing: need });
    }
    audit(db, { actor, eventId, action: 'assignment.auto', subjectType: 'event', subjectId: eventId, detail: { created, offTrack, shortfall: shortfall.length, target: event.reviews_per_project }, at: now });
  });
  return { created, shortfall, offTrack };
}

export function assign(db: Db, clock: Clock, actor: Actor, eventId: string, judgeId: string, projectId: string): void {
  requireOrganizer(db, actor, eventId);
  if (!eventRoles(db, judgeId, eventId).has('judge')) throw badRequest('That user is not a judge for this event.', 'validation');
  const p = getProject(db, projectId);
  if (!p || p.event_id !== eventId) throw notFound('No such project in this event.');
  if (get(db, 'SELECT 1 FROM conflicts WHERE event_id = ? AND judge_id = ? AND team_id = ?', eventId, judgeId, p.team_id)) throw conflict('This judge has a declared conflict with that team.', 'conflict_of_interest');
  tx(db, () => {
    if (run(db, "INSERT OR IGNORE INTO assignments (event_id, judge_id, project_id, source, assigned_by, assigned_at) VALUES (?, ?, ?, 'manual', ?, ?)", eventId, judgeId, projectId, actor.user!.id, iso(clock.now())) === 0) throw conflict('Already assigned.', 'already_assigned');
    audit(db, { actor, eventId, action: 'assignment.add', subjectType: 'project', subjectId: projectId, detail: { judgeId }, at: iso(clock.now()) });
  });
}

export function unassign(db: Db, clock: Clock, actor: Actor, eventId: string, judgeId: string, projectId: string): void {
  requireOrganizer(db, actor, eventId);
  if (get(db, 'SELECT 1 FROM scores WHERE judge_id = ? AND project_id = ?', judgeId, projectId)) throw conflict('This review is already scored; unassigning would delete it.', 'already_scored');
  tx(db, () => {
    if (run(db, 'DELETE FROM assignments WHERE event_id = ? AND judge_id = ? AND project_id = ?', eventId, judgeId, projectId) === 0) throw notFound('No such assignment.');
    audit(db, { actor, eventId, action: 'assignment.remove', subjectType: 'project', subjectId: projectId, detail: { judgeId }, at: iso(clock.now()) });
  });
}

/** A judge declares a conflict of interest: the unscored assignment is dropped and future auto-assignment skips the team. */
export function recuse(db: Db, clock: Clock, actor: Actor, eventId: string, projectId: string, reason: string): void {
  const judge = requireJudge(db, actor, eventId);
  const p = getProject(db, projectId);
  if (!p || p.event_id !== eventId) throw notFound();
  if (get(db, 'SELECT 1 FROM scores WHERE judge_id = ? AND project_id = ?', judge.id, projectId)) throw conflict('You already scored this project; ask an organizer.', 'already_scored');
  tx(db, () => {
    const now = iso(clock.now());
    run(db, 'INSERT OR REPLACE INTO conflicts (event_id, judge_id, team_id, reason, declared_by, declared_at) VALUES (?, ?, ?, ?, ?, ?)', eventId, judge.id, p.team_id, reason.slice(0, 300) || 'declared by judge', judge.id, now);
    run(db, 'DELETE FROM assignments WHERE judge_id = ? AND project_id = ?', judge.id, projectId);
    audit(db, { actor, eventId, action: 'judge.recuse', subjectType: 'project', subjectId: projectId, detail: { reason }, at: now });
  });
}

export function assertJudgingOpen(event: EventRow, clock: Clock): void {
  const p = phase(event, clock.now());
  if (p === 'upcoming' || p === 'open') throw forbidden('Judging starts when submissions close.', 'judging_not_open');
  if (p === 'closed') throw forbidden('The judging window has closed.', 'judging_closed');
  if (p === 'published') throw forbidden('Results are published; scores are locked.', 'results_published');
}

export interface OwnScore {
  id: string;
  event_id: string;
  project_id: string;
  project_title: string;
  comment: string;
  values: Record<string, number>;
  updated_at: string;
}

export function scoreValues(db: Db, scoreId: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of all<{ key: string; value: number }>(db, 'SELECT c.key, v.value FROM score_values v JOIN criteria c ON c.id = v.criterion_id WHERE v.score_id = ? ORDER BY c.position', scoreId)) out[r.key] = r.value;
  return out;
}

export function upsertScore(db: Db, clock: Clock, actor: Actor, eventId: string, projectId: string, input: Record<string, unknown>): OwnScore {
  const judge = requireJudge(db, actor, eventId);
  const event = getEvent(db, eventId)!;
  assertJudgingOpen(event, clock);
  if (!get(db, 'SELECT 1 FROM assignments WHERE judge_id = ? AND project_id = ? AND event_id = ?', judge.id, projectId, eventId)) throw forbidden('This project is not assigned to you.', 'not_assigned');
  const rubric = criteria(db, eventId);
  const rawValues = (input.values && typeof input.values === 'object' ? input.values : input) as Record<string, unknown>;
  const values = rubric.map((c) => {
    const raw = rawValues[c.key] ?? rawValues[`c_${c.key}`];
    const v = Number(raw);
    if (raw === undefined || raw === '' || !Number.isInteger(v) || v < c.scale_min || v > c.scale_max) throw badRequest(`"${c.name}" needs a whole number from ${c.scale_min} to ${c.scale_max}.`, 'validation');
    return { c, v };
  });
  const comment = str(input, 'comment', { optional: true, max: 4000 });
  return tx(db, () => {
    const now = iso(clock.now());
    const prev = get<{ id: string }>(db, 'SELECT id FROM scores WHERE judge_id = ? AND project_id = ?', judge.id, projectId);
    const id = prev?.id ?? newId('scr');
    const before = prev ? scoreValues(db, id) : null;
    if (prev) run(db, 'UPDATE scores SET comment = ?, updated_at = ? WHERE id = ?', comment, now, id);
    else run(db, 'INSERT INTO scores (id, event_id, judge_id, project_id, comment, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)', id, eventId, judge.id, projectId, comment, now, now);
    run(db, 'DELETE FROM score_values WHERE score_id = ?', id);
    for (const { c, v } of values) run(db, 'INSERT INTO score_values (score_id, criterion_id, value) VALUES (?, ?, ?)', id, c.id, v);
    const after = Object.fromEntries(values.map(({ c, v }) => [c.key, v]));
    audit(db, { actor, eventId, action: prev ? 'score.update' : 'score.create', subjectType: 'project', subjectId: projectId, detail: before ? { before, after } : { after }, at: now });
    return ownScores(db, judge.id, eventId).find((s) => s.id === id)!;
  });
}

export function ownScores(db: Db, judgeId: string, eventId?: string): OwnScore[] {
  const rows = all<Omit<OwnScore, 'values'>>(
    db,
    `SELECT s.id, s.event_id, s.project_id, p.title project_title, s.comment, s.updated_at
       FROM scores s JOIN projects p ON p.id = s.project_id
      WHERE s.judge_id = ? ${eventId ? 'AND s.event_id = ?' : ''} ORDER BY s.updated_at DESC`,
    ...(eventId ? [judgeId, eventId] : [judgeId]),
  );
  return rows.map((r) => ({ ...r, values: scoreValues(db, r.id) }));
}

/** GET a judge's scores. The authorization check is the first line, before any read. */
export function readJudgeScores(db: Db, actor: Actor, judgeId: string, eventId: string | null): { judge: string; scores: OwnScore[] } {
  const user = requireUser(actor);
  const target = judgeId === 'me' ? user.id : judgeId;
  const events = eventId ? [eventId] : judgedEventIds(db, target);
  if (events.length === 0) {
    if (target === user.id) throw forbidden('You are not a judge in any event.', 'not_judge');
    // Only organizers of an event the target judges may read them; with none, refuse.
    throw forbidden('You may only read your own scores.', 'peer_scores_forbidden');
  }
  for (const e of events) assertCanReadJudgeScores(db, actor, target, e);
  return { judge: target, scores: events.flatMap((e) => ownScores(db, target, e)) };
}

export interface QueueItem {
  project_id: string;
  title: string;
  summary: string;
  team_name: string;
  track_name: string | null;
  repo_url: string;
  demo_url: string;
  score_id: string | null;
}

export function judgeQueue(db: Db, actor: Actor, eventId: string): QueueItem[] {
  const judge = requireJudge(db, actor, eventId);
  return all<QueueItem>(
    db,
    `SELECT p.id project_id, p.title, p.summary, t.name team_name, tr.name track_name, p.repo_url, p.demo_url, s.id score_id
       FROM assignments a JOIN projects p ON p.id = a.project_id JOIN teams t ON t.id = p.team_id
       LEFT JOIN tracks tr ON tr.id = p.track_id LEFT JOIN scores s ON s.judge_id = a.judge_id AND s.project_id = a.project_id
      WHERE a.judge_id = ? AND a.event_id = ? ORDER BY (s.id IS NOT NULL), p.title`,
    judge.id, eventId,
  );
}

export interface Progress {
  event_id: string;
  phase: string;
  generated_at: string;
  projects: { submitted: number; drafts: number; duplicates: number };
  target_reviews_per_project: number;
  assignments: number;
  scored: number;
  percent: number;
  under_reviewed: Array<{ project_id: string; title: string; scored: number; assigned: number }>;
  judges: Array<{ id: string; name: string; assigned: number; scored: number; last_activity: string | null }>;
}

export function progress(db: Db, clock: Clock, actor: Actor, eventId: string): Progress {
  requireOrganizer(db, actor, eventId);
  const event = getEvent(db, eventId)!;
  const count = (sql: string) => get<{ n: number }>(db, sql, eventId)!.n;
  const assignments = count('SELECT COUNT(*) n FROM assignments WHERE event_id = ?');
  const scored = count('SELECT COUNT(*) n FROM scores WHERE event_id = ?');
  return {
    event_id: eventId,
    phase: phase(event, clock.now()),
    generated_at: iso(clock.now()),
    projects: {
      submitted: count("SELECT COUNT(*) n FROM projects WHERE event_id = ? AND status = 'submitted' AND duplicate_of IS NULL"),
      drafts: count("SELECT COUNT(*) n FROM projects WHERE event_id = ? AND status = 'draft'"),
      duplicates: count('SELECT COUNT(*) n FROM projects WHERE event_id = ? AND duplicate_of IS NOT NULL'),
    },
    target_reviews_per_project: event.reviews_per_project,
    assignments,
    scored,
    percent: assignments ? Math.round((100 * scored) / assignments) : 0,
    under_reviewed: all(
      db,
      `SELECT p.id project_id, p.title,
              (SELECT COUNT(*) FROM scores s WHERE s.project_id = p.id) scored,
              (SELECT COUNT(*) FROM assignments a WHERE a.project_id = p.id) assigned
         FROM projects p WHERE p.event_id = ? AND p.status = 'submitted' AND p.duplicate_of IS NULL
        GROUP BY p.id HAVING scored < ? ORDER BY scored, p.title`,
      eventId, event.reviews_per_project,
    ),
    judges: all(
      db,
      `SELECT u.id, u.name,
              (SELECT COUNT(*) FROM assignments a WHERE a.event_id = r.event_id AND a.judge_id = u.id) assigned,
              (SELECT COUNT(*) FROM scores s WHERE s.event_id = r.event_id AND s.judge_id = u.id) scored,
              (SELECT MAX(s.updated_at) FROM scores s WHERE s.event_id = r.event_id AND s.judge_id = u.id) last_activity
         FROM event_roles r JOIN users u ON u.id = r.user_id WHERE r.event_id = ? AND r.role = 'judge'
        ORDER BY (assigned - scored) DESC, u.name`,
      eventId,
    ),
  };
}
