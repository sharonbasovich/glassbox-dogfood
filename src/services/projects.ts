import { type Db, all, get, run, tx } from '../db/index.ts';
import { newId, str, urlField, badRequest, notFound, forbidden, conflict, iso, isoField, type Clock } from '../util.ts';
import type { Actor } from './auth.ts';
import { isOrganizer, requireOrganizer, requireUser, teamMembership } from './authz.ts';
import { audit } from './audit.ts';
import { type EventRow, getEvent, loadEvent } from './events.ts';

export interface Project {
  id: string;
  event_id: string;
  team_id: string;
  track_id: string | null;
  title: string;
  summary: string;
  description: string;
  repo_url: string;
  demo_url: string;
  status: 'draft' | 'submitted';
  submitted_at: string | null;
  duplicate_of: string | null;
  created_at: string;
  updated_at: string;
}

export interface GalleryItem extends Project {
  team_name: string;
  track_name: string | null;
  event_name: string;
  event_slug: string;
}

/** The deadline a team is held to: the event close, or a later per-team extension. */
export function effectiveClose(db: Db, event: EventRow, teamId: string): string {
  const ext = get<{ until: string }>(db, 'SELECT until FROM deadline_extensions WHERE event_id = ? AND team_id = ?', event.id, teamId);
  return ext && ext.until > event.submissions_close_at ? ext.until : event.submissions_close_at;
}

/**
 * The one deadline check. Every write to a project goes through here, on the
 * server clock, so the deadline holds for the API, the forms and any script.
 */
export function assertSubmissionWindow(db: Db, clock: Clock, event: EventRow, teamId: string): void {
  const now = iso(clock.now());
  if (now < event.submissions_open_at) throw forbidden(`Submissions open at ${event.submissions_open_at}.`, 'submissions_not_open');
  const close = effectiveClose(db, event, teamId);
  if (now >= close) throw forbidden(`Submissions closed at ${close}. The deadline is enforced by the server.`, 'submissions_closed');
}

export function getProject(db: Db, id: string): Project | undefined {
  return get<Project>(db, 'SELECT * FROM projects WHERE id = ?', id);
}

export function teamProject(db: Db, teamId: string): Project | undefined {
  return get<Project>(db, 'SELECT * FROM projects WHERE team_id = ? AND duplicate_of IS NULL', teamId);
}

function readFields(db: Db, eventId: string, input: Record<string, unknown>, partial: Project | null) {
  const pick = (k: string, fn: () => string) => (partial && input[k] === undefined ? (partial as unknown as Record<string, string>)[k]! : fn());
  const trackIn = input.track_id ?? input.track;
  let trackId = partial?.track_id ?? null;
  if (trackIn !== undefined) {
    trackId = String(trackIn || '') || null;
    if (trackId && !get(db, 'SELECT 1 FROM tracks WHERE id = ? AND event_id = ?', trackId, eventId)) throw badRequest('Unknown track for this event.', 'validation');
  }
  return {
    title: pick('title', () => str(input, 'title', { max: 120 })),
    summary: pick('summary', () => str(input, 'summary', { optional: true, max: 280 })),
    description: pick('description', () => str(input, 'description', { optional: true, max: 20000 })),
    repo_url: pick('repo_url', () => urlField(input, 'repo_url')),
    demo_url: pick('demo_url', () => urlField(input, 'demo_url')),
    track_id: trackId,
  };
}

function requireTeamOf(db: Db, actor: Actor, eventId: string): string {
  const user = requireUser(actor);
  const m = teamMembership(db, user.id, eventId);
  if (!m) throw forbidden('Join or create a team for this event before submitting.', 'no_team');
  return m.team_id;
}

/** Creates the team's entry as a draft (or submits immediately when submit=true). */
export function createProject(db: Db, clock: Clock, actor: Actor, eventIdOrSlug: string, input: Record<string, unknown>): Project {
  const event = loadEvent(db, actor, eventIdOrSlug);
  const teamId = requireTeamOf(db, actor, event.id);
  assertSubmissionWindow(db, clock, event, teamId);
  if (teamProject(db, teamId)) throw conflict('Your team already has an entry; edit it instead.', 'already_has_project');
  const f = readFields(db, event.id, input, null);
  const submit = input.submit === true || input.submit === 'true' || input.action === 'submit';
  return tx(db, () => {
    const id = newId('prj');
    const now = iso(clock.now());
    run(
      db,
      `INSERT INTO projects (id, event_id, team_id, track_id, title, summary, description, repo_url, demo_url, status, submitted_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id, event.id, teamId, f.track_id, f.title, f.summary, f.description, f.repo_url, f.demo_url,
      submit ? 'submitted' : 'draft', submit ? now : null, now, now,
    );
    audit(db, { actor, eventId: event.id, action: submit ? 'project.submit' : 'project.draft', subjectType: 'project', subjectId: id, detail: { title: f.title }, at: now });
    return getProject(db, id)!;
  });
}

export function updateProject(db: Db, clock: Clock, actor: Actor, projectId: string, input: Record<string, unknown>): Project {
  const p = getProject(db, projectId);
  if (!p) throw notFound();
  const event = getEvent(db, p.event_id)!;
  const teamId = requireTeamOf(db, actor, event.id);
  if (teamId !== p.team_id) throw forbidden('Only members of this team can edit its entry.', 'not_member');
  assertSubmissionWindow(db, clock, event, teamId);
  const f = readFields(db, event.id, input, p);
  const action = input.action === 'submit' || input.submit === true || input.submit === 'true' ? 'submit' : input.action === 'unsubmit' ? 'unsubmit' : 'save';
  return tx(db, () => {
    const now = iso(clock.now());
    const status = action === 'submit' ? 'submitted' : action === 'unsubmit' ? 'draft' : p.status;
    const submittedAt = status === 'submitted' ? (action === 'submit' ? now : p.submitted_at) : null;
    run(
      db,
      `UPDATE projects SET track_id = ?, title = ?, summary = ?, description = ?, repo_url = ?, demo_url = ?, status = ?, submitted_at = ?, updated_at = ? WHERE id = ?`,
      f.track_id, f.title, f.summary, f.description, f.repo_url, f.demo_url, status, submittedAt, now, p.id,
    );
    const changed = (Object.keys(f) as (keyof typeof f)[]).filter((k) => f[k] !== p[k]);
    audit(db, { actor, eventId: event.id, action: `project.${action === 'save' ? 'edit' : action}`, subjectType: 'project', subjectId: p.id, detail: { changed }, at: now });
    return getProject(db, p.id)!;
  });
}

/** Visibility of a single project: submitted entries of public events are public; drafts only to team and organizers. */
export function loadProjectFor(db: Db, actor: Actor, id: string): Project {
  const p = getProject(db, id);
  if (!p) throw notFound('No such project.');
  const event = getEvent(db, p.event_id)!;
  const own = teamMembership(db, actor.user?.id, p.event_id)?.team_id === p.team_id;
  const org = isOrganizer(db, actor, p.event_id);
  const judgeAssigned = !!actor.user && !!get(db, 'SELECT 1 FROM assignments WHERE judge_id = ? AND project_id = ?', actor.user.id, p.id);
  if (own || org || judgeAssigned) return p;
  if (p.status !== 'submitted' || event.visibility !== 'public') throw notFound('No such project.');
  return p;
}

export interface GalleryQuery {
  q?: string;
  event?: string;
  track?: string;
  sort?: 'title' | 'recent' | 'event';
  page?: number;
}

export const GALLERY_PAGE_SIZE = 60;

export function gallery(db: Db, query: GalleryQuery): { items: GalleryItem[]; total: number; page: number; pages: number } {
  const where = ["p.status = 'submitted'", "e.visibility = 'public'", 'p.duplicate_of IS NULL'];
  const params: string[] = [];
  if (query.q) {
    where.push("(p.title LIKE ? ESCAPE '\\' OR p.summary LIKE ? ESCAPE '\\' OR t.name LIKE ? ESCAPE '\\')");
    const like = `%${query.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    params.push(like, like, like);
  }
  if (query.event) {
    where.push('(e.id = ? OR e.slug = ?)');
    params.push(query.event, query.event);
  }
  if (query.track) {
    where.push('(p.track_id = ? OR tr.name = ?)');
    params.push(query.track, query.track);
  }
  const order = query.sort === 'recent' ? 'p.submitted_at DESC' : query.sort === 'event' ? 'e.submissions_close_at DESC, p.title' : 'p.title COLLATE NOCASE';
  const from = `FROM projects p JOIN events e ON e.id = p.event_id JOIN teams t ON t.id = p.team_id LEFT JOIN tracks tr ON tr.id = p.track_id WHERE ${where.join(' AND ')}`;
  const total = get<{ n: number }>(db, `SELECT COUNT(*) n ${from}`, ...params)!.n;
  const pages = Math.max(1, Math.ceil(total / GALLERY_PAGE_SIZE));
  const page = Math.min(Math.max(1, query.page ?? 1), pages);
  const items = all<GalleryItem>(
    db,
    `SELECT p.*, t.name team_name, tr.name track_name, e.name event_name, e.slug event_slug ${from} ORDER BY ${order} LIMIT ? OFFSET ?`,
    ...params, GALLERY_PAGE_SIZE, (page - 1) * GALLERY_PAGE_SIZE,
  );
  return { items, total, page, pages };
}

export function eventProjects(db: Db, eventId: string, includeDrafts: boolean): GalleryItem[] {
  return all<GalleryItem>(
    db,
    `SELECT p.*, t.name team_name, tr.name track_name, e.name event_name, e.slug event_slug
       FROM projects p JOIN events e ON e.id = p.event_id JOIN teams t ON t.id = p.team_id LEFT JOIN tracks tr ON tr.id = p.track_id
      WHERE p.event_id = ? ${includeDrafts ? '' : "AND p.status = 'submitted'"} ORDER BY p.title COLLATE NOCASE`,
    eventId,
  );
}

/** Organizer resolution of a duplicate: `keepId` becomes canonical, the rest of that team's entries point at it. */
export function resolveDuplicate(db: Db, clock: Clock, actor: Actor, keepId: string): void {
  const keep = getProject(db, keepId);
  if (!keep) throw notFound();
  requireOrganizer(db, actor, keep.event_id);
  tx(db, () => {
    const others = all<{ id: string }>(db, 'SELECT id FROM projects WHERE team_id = ? AND id <> ?', keep.team_id, keep.id);
    for (const o of others) run(db, 'UPDATE projects SET duplicate_of = ? WHERE id = ?', keep.id, o.id);
    run(db, 'UPDATE projects SET duplicate_of = NULL WHERE id = ?', keep.id);
    audit(db, { actor, eventId: keep.event_id, action: 'project.duplicate_resolve', subjectType: 'project', subjectId: keep.id, detail: { duplicates: others.map((o) => o.id) }, at: iso(clock.now()) });
  });
}

export function grantExtension(db: Db, clock: Clock, actor: Actor, eventId: string, input: Record<string, unknown>): void {
  requireOrganizer(db, actor, eventId);
  const teamId = str(input, 'team_id', { max: 40 });
  const until = isoField(input, 'until')!;
  const reason = str(input, 'reason', { max: 300 });
  if (!get(db, 'SELECT 1 FROM teams WHERE id = ? AND event_id = ?', teamId, eventId)) throw notFound('No such team.');
  tx(db, () => {
    run(db, 'INSERT OR REPLACE INTO deadline_extensions (event_id, team_id, until, reason, granted_by, granted_at) VALUES (?, ?, ?, ?, ?, ?)', eventId, teamId, until, reason, actor.user!.id, iso(clock.now()));
    audit(db, { actor, eventId, action: 'deadline.extend', subjectType: 'team', subjectId: teamId, detail: { until, reason }, at: iso(clock.now()) });
  });
}
