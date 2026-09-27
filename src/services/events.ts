import { type Db, all, get, run, tx } from '../db/index.ts';
import { newId, slugify, str, isoField, badRequest, notFound, forbidden, conflict, iso, type Clock } from '../util.ts';
import type { Actor } from './auth.ts';
import { canCreateEvents, isOrganizer, requireOrganizer, requireUser } from './authz.ts';
import { audit } from './audit.ts';

export interface EventRow {
  id: string;
  slug: string;
  name: string;
  tagline: string;
  description: string;
  visibility: 'draft' | 'public';
  submissions_open_at: string;
  submissions_close_at: string;
  judging_close_at: string | null;
  max_team_size: number;
  reviews_per_project: number;
  normalization: 'none' | 'zscore_shrunk';
  shrinkage_k: number;
  results_published_at: string | null;
  created_at: string;
}

export interface Track { id: string; event_id: string; name: string; description: string; position: number }
export interface Prize { id: string; event_id: string; track_id: string | null; name: string; description: string; position: number }
export interface Criterion {
  id: string; event_id: string; key: string; name: string; description: string;
  weight: number; scale_min: number; scale_max: number; position: number;
}

export type Phase = 'upcoming' | 'open' | 'judging' | 'closed' | 'published';

export function phase(e: EventRow, now: Date): Phase {
  const t = iso(now);
  if (e.results_published_at) return 'published';
  if (t < e.submissions_open_at) return 'upcoming';
  if (t < e.submissions_close_at) return 'open';
  if (!e.judging_close_at || t < e.judging_close_at) return 'judging';
  return 'closed';
}

export function getEvent(db: Db, idOrSlug: string): EventRow | undefined {
  return get<EventRow>(db, 'SELECT * FROM events WHERE id = ? OR slug = ?', idOrSlug, idOrSlug);
}

/** Loads an event the actor may see (drafts only for organizers). */
export function loadEvent(db: Db, actor: Actor, idOrSlug: string): EventRow {
  const e = getEvent(db, idOrSlug);
  if (!e || (e.visibility === 'draft' && !isOrganizer(db, actor, e.id))) throw notFound('No such event.');
  return e;
}

export function listEvents(db: Db, actor: Actor): EventRow[] {
  return all<EventRow>(db, 'SELECT * FROM events ORDER BY submissions_close_at DESC').filter(
    (e) => e.visibility === 'public' || isOrganizer(db, actor, e.id),
  );
}

export function tracks(db: Db, eventId: string): Track[] {
  return all<Track>(db, 'SELECT * FROM tracks WHERE event_id = ? ORDER BY position, name', eventId);
}
export function prizes(db: Db, eventId: string): Prize[] {
  return all<Prize>(db, 'SELECT * FROM prizes WHERE event_id = ? ORDER BY position, name', eventId);
}
export function criteria(db: Db, eventId: string): Criterion[] {
  return all<Criterion>(db, 'SELECT * FROM criteria WHERE event_id = ? ORDER BY position, key', eventId);
}

function uniqueSlug(db: Db, base: string): string {
  let slug = slugify(base);
  for (let i = 2; get(db, 'SELECT 1 FROM events WHERE slug = ?', slug); i++) slug = `${slugify(base)}-${i}`;
  return slug;
}

function readEventFields(input: Record<string, unknown>) {
  const open = isoField(input, 'submissions_open_at');
  const close = isoField(input, 'submissions_close_at');
  const judging = isoField(input, 'judging_close_at', true);
  if (!open || !close) throw badRequest('Submission open and close dates are required.', 'validation');
  if (close <= open) throw badRequest('Submissions must close after they open.', 'validation');
  if (judging && judging < close) throw badRequest('Judging must close after submissions close.', 'validation');
  const intIn = (k: string, def: number, lo: number, hi: number) => {
    const n = input[k] === undefined || input[k] === '' ? def : Number(input[k]);
    if (!Number.isInteger(n) || n < lo || n > hi) throw badRequest(`"${k}" must be an integer between ${lo} and ${hi}.`, 'validation');
    return n;
  };
  const visibility = input.visibility === 'draft' ? 'draft' : 'public';
  const normalization = input.normalization === 'none' ? 'none' : 'zscore_shrunk';
  return {
    name: str(input, 'name', { max: 120 }),
    tagline: str(input, 'tagline', { optional: true, max: 200 }),
    description: str(input, 'description', { optional: true, max: 10000 }),
    visibility, open, close, judging, normalization,
    maxTeam: intIn('max_team_size', 4, 1, 20),
    reviews: intIn('reviews_per_project', 3, 1, 20),
  } as const;
}

export const DEFAULT_CRITERIA = [
  { key: 'functionality', name: 'Functionality', description: 'Does it work end to end?', weight: 0.4 },
  { key: 'quality', name: 'Quality', description: 'Code, UX and documentation quality.', weight: 0.35 },
  { key: 'innovation', name: 'Innovation', description: 'Is the idea or approach new?', weight: 0.25 },
];

export function createEvent(db: Db, clock: Clock, actor: Actor, input: Record<string, unknown>, opts: { id?: string; sourceRef?: string } = {}): EventRow {
  const user = requireUser(actor);
  if (!canCreateEvents(actor)) throw forbidden('Your account cannot create events. Ask an admin for organizer access.', 'cannot_create_events');
  const f = readEventFields(input);
  return tx(db, () => {
    const id = opts.id ?? newId('evt');
    const now = iso(clock.now());
    run(
      db,
      `INSERT INTO events (id, slug, name, tagline, description, visibility, submissions_open_at, submissions_close_at,
         judging_close_at, max_team_size, reviews_per_project, normalization, source_ref, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id, uniqueSlug(db, str(input, 'slug', { optional: true, max: 60 }) || f.name), f.name, f.tagline, f.description, f.visibility,
      f.open, f.close, f.judging, f.maxTeam, f.reviews, f.normalization, opts.sourceRef ?? null, user.id, now,
    );
    run(db, "INSERT INTO event_roles (event_id, user_id, role, created_at) VALUES (?, ?, 'organizer', ?)", id, user.id, now);
    const trackNames = String(input.tracks ?? '').split(/\r?\n|,/).map((s) => s.trim()).filter(Boolean);
    trackNames.forEach((name, i) => run(db, 'INSERT INTO tracks (id, event_id, name, position) VALUES (?, ?, ?, ?)', newId('trk'), id, name.slice(0, 80), i));
    const prizeNames = String(input.prizes ?? '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    prizeNames.forEach((name, i) => run(db, 'INSERT INTO prizes (id, event_id, name, position) VALUES (?, ?, ?, ?)', newId('prz'), id, name.slice(0, 120), i));
    if (input.default_criteria !== false && input.default_criteria !== 'false') {
      DEFAULT_CRITERIA.forEach((c, i) =>
        run(db, 'INSERT INTO criteria (id, event_id, key, name, description, weight, position) VALUES (?, ?, ?, ?, ?, ?, ?)', newId('crt'), id, c.key, c.name, c.description, c.weight, i),
      );
    }
    audit(db, { actor, eventId: id, action: 'event.create', subjectType: 'event', subjectId: id, detail: { name: f.name, close: f.close }, at: now });
    return getEvent(db, id)!;
  });
}

export function updateEvent(db: Db, clock: Clock, actor: Actor, eventId: string, input: Record<string, unknown>): EventRow {
  requireOrganizer(db, actor, eventId);
  const before = getEvent(db, eventId);
  if (!before) throw notFound();
  const f = readEventFields(input);
  return tx(db, () => {
    run(
      db,
      `UPDATE events SET name = ?, tagline = ?, description = ?, visibility = ?, submissions_open_at = ?, submissions_close_at = ?,
         judging_close_at = ?, max_team_size = ?, reviews_per_project = ?, normalization = ? WHERE id = ?`,
      f.name, f.tagline, f.description, f.visibility, f.open, f.close, f.judging, f.maxTeam, f.reviews, f.normalization, eventId,
    );
    const changed: Record<string, [unknown, unknown]> = {};
    const after = getEvent(db, eventId)!;
    for (const k of Object.keys(after) as (keyof EventRow)[]) if (before[k] !== after[k]) changed[k] = [before[k], after[k]];
    audit(db, { actor, eventId, action: 'event.update', subjectType: 'event', subjectId: eventId, detail: changed, at: iso(clock.now()) });
    return after;
  });
}

export function addTrack(db: Db, clock: Clock, actor: Actor, eventId: string, input: Record<string, unknown>): Track {
  requireOrganizer(db, actor, eventId);
  const name = str(input, 'name', { max: 80 });
  if (get(db, 'SELECT 1 FROM tracks WHERE event_id = ? AND name = ?', eventId, name)) throw conflict('That track already exists.');
  return tx(db, () => {
    const id = newId('trk');
    const pos = get<{ n: number }>(db, 'SELECT COUNT(*) n FROM tracks WHERE event_id = ?', eventId)!.n;
    run(db, 'INSERT INTO tracks (id, event_id, name, description, position) VALUES (?, ?, ?, ?, ?)', id, eventId, name, str(input, 'description', { optional: true, max: 500 }), pos);
    audit(db, { actor, eventId, action: 'track.create', subjectType: 'track', subjectId: id, detail: { name }, at: iso(clock.now()) });
    return get<Track>(db, 'SELECT * FROM tracks WHERE id = ?', id)!;
  });
}

export function addPrize(db: Db, clock: Clock, actor: Actor, eventId: string, input: Record<string, unknown>): Prize {
  requireOrganizer(db, actor, eventId);
  const name = str(input, 'name', { max: 120 });
  const trackId = str(input, 'track_id', { optional: true, max: 40 }) || null;
  if (trackId && !get(db, 'SELECT 1 FROM tracks WHERE id = ? AND event_id = ?', trackId, eventId)) throw badRequest('Unknown track.', 'validation');
  return tx(db, () => {
    const id = newId('prz');
    const pos = get<{ n: number }>(db, 'SELECT COUNT(*) n FROM prizes WHERE event_id = ?', eventId)!.n;
    run(db, 'INSERT INTO prizes (id, event_id, track_id, name, description, position) VALUES (?, ?, ?, ?, ?, ?)', id, eventId, trackId, name, str(input, 'description', { optional: true, max: 500 }), pos);
    audit(db, { actor, eventId, action: 'prize.create', subjectType: 'prize', subjectId: id, detail: { name, trackId }, at: iso(clock.now()) });
    return get<Prize>(db, 'SELECT * FROM prizes WHERE id = ?', id)!;
  });
}

export function deleteTrackOrPrize(db: Db, clock: Clock, actor: Actor, eventId: string, kind: 'track' | 'prize', id: string): void {
  requireOrganizer(db, actor, eventId);
  const table = kind === 'track' ? 'tracks' : 'prizes';
  tx(db, () => {
    if (run(db, `DELETE FROM ${table} WHERE id = ? AND event_id = ?`, id, eventId) === 0) throw notFound();
    audit(db, { actor, eventId, action: `${kind}.delete`, subjectType: kind, subjectId: id, at: iso(clock.now()) });
  });
}

/**
 * Replaces the rubric. Weights are relative (they are renormalised to sum to 1
 * when totals are computed). Criteria that already have scores cannot be
 * removed or have their scale changed; their weight can always change.
 */
export function saveCriteria(db: Db, clock: Clock, actor: Actor, eventId: string, rows: Array<Record<string, unknown>>): Criterion[] {
  requireOrganizer(db, actor, eventId);
  if (rows.length === 0 || rows.length > 12) throw badRequest('A rubric needs between 1 and 12 criteria.', 'validation');
  const existing = new Map(criteria(db, eventId).map((c) => [c.key, c]));
  const seen = new Set<string>();
  return tx(db, () => {
    rows.forEach((r, i) => {
      const name = str(r, 'name', { max: 80 });
      const key = (str(r, 'key', { optional: true, max: 40 }) || name).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
      if (!key || seen.has(key)) throw badRequest(`Duplicate or empty criterion key "${key}".`, 'validation');
      seen.add(key);
      const weight = Number(r.weight);
      if (!(weight > 0) || weight > 100) throw badRequest(`Weight for "${name}" must be > 0 and ≤ 100.`, 'validation');
      const min = r.scale_min === undefined || r.scale_min === '' ? 1 : Number(r.scale_min);
      const max = r.scale_max === undefined || r.scale_max === '' ? 5 : Number(r.scale_max);
      if (!Number.isInteger(min) || !Number.isInteger(max) || max <= min || max - min > 100) throw badRequest(`Scale for "${name}" is invalid.`, 'validation');
      const description = str(r, 'description', { optional: true, max: 500 });
      const prev = existing.get(key);
      if (prev) {
        const used = get(db, 'SELECT 1 FROM score_values WHERE criterion_id = ? LIMIT 1', prev.id);
        if (used && (prev.scale_min !== min || prev.scale_max !== max)) throw conflict(`"${name}" already has scores; its scale cannot change.`, 'criterion_in_use');
        run(db, 'UPDATE criteria SET name = ?, description = ?, weight = ?, scale_min = ?, scale_max = ?, position = ? WHERE id = ?', name, description, weight, min, max, i, prev.id);
      } else {
        run(db, 'INSERT INTO criteria (id, event_id, key, name, description, weight, scale_min, scale_max, position) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', newId('crt'), eventId, key, name, description, weight, min, max, i);
      }
    });
    for (const [key, c] of existing) {
      if (seen.has(key)) continue;
      if (get(db, 'SELECT 1 FROM score_values WHERE criterion_id = ? LIMIT 1', c.id)) throw conflict(`"${c.name}" already has scores and cannot be removed.`, 'criterion_in_use');
      run(db, 'DELETE FROM criteria WHERE id = ?', c.id);
    }
    const after = criteria(db, eventId);
    audit(db, {
      actor, eventId, action: 'rubric.update', subjectType: 'event', subjectId: eventId,
      detail: { criteria: after.map((c) => ({ key: c.key, weight: c.weight, scale: [c.scale_min, c.scale_max] })) }, at: iso(clock.now()),
    });
    return after;
  });
}
