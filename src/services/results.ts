import { type Db, all, get, run, tx } from '../db/index.ts';
import { newId, notFound, conflict, forbidden, iso, sha256, type Clock } from '../util.ts';
import type { Actor } from './auth.ts';
import { isOrganizer, requireOrganizer } from './authz.ts';
import { audit } from './audit.ts';
import { type EventRow, criteria, getEvent, loadEvent, prizes } from './events.ts';
import { normalize, type Outcome, type Review } from '../scoring/normalize.ts';

export interface RankedProject {
  rank: number;
  raw_rank: number;
  project_id: string;
  title: string;
  team: string;
  track: string | null;
  reviews: number;
  raw: number;
  adjusted: number;
  stderr: number;
  criteria: Record<string, number>;
}

export interface Computed {
  event: EventRow;
  outcome: Outcome;
  ranking: RankedProject[];
  judgeNames: Record<string, string>;
}

/** Loads every final score for canonical submitted projects and runs the configured normalization. */
export function compute(db: Db, event: EventRow): Computed {
  const rubric = criteria(db, event.id);
  const projects = all<{ id: string; title: string; team: string; track: string | null }>(
    db,
    `SELECT p.id, p.title, t.name team, tr.name track FROM projects p JOIN teams t ON t.id = p.team_id
       LEFT JOIN tracks tr ON tr.id = p.track_id
      WHERE p.event_id = ? AND p.status = 'submitted' AND p.duplicate_of IS NULL`,
    event.id,
  );
  const ids = new Set(projects.map((p) => p.id));
  const rows = all<{ score_id: string; judge_id: string; project_id: string; criterion_id: string; value: number }>(
    db,
    `SELECT s.id score_id, s.judge_id, s.project_id, v.criterion_id, v.value
       FROM scores s JOIN score_values v ON v.score_id = s.id WHERE s.event_id = ?`,
    event.id,
  );
  const reviews = new Map<string, Review>();
  for (const r of rows) {
    if (!ids.has(r.project_id)) continue;
    const rev = reviews.get(r.score_id) ?? { judgeId: r.judge_id, projectId: r.project_id, values: {} };
    rev.values[r.criterion_id] = r.value;
    reviews.set(r.score_id, rev);
  }
  const outcome = normalize(rubric, [...reviews.values()], event.normalization, event.shrinkage_k, [...ids]);
  const meta = new Map(projects.map((p) => [p.id, p]));
  const ranking = outcome.projects.map((p) => {
    const m = meta.get(p.projectId)!;
    return {
      rank: p.rank, raw_rank: p.rawRank, project_id: p.projectId, title: m.title, team: m.team, track: m.track,
      reviews: p.reviews, raw: p.raw, adjusted: p.adjusted, stderr: p.stderr, criteria: p.criteria,
    };
  });
  const judgeNames = Object.fromEntries(
    all<{ id: string; name: string }>(db, "SELECT u.id, u.name FROM event_roles r JOIN users u ON u.id = r.user_id WHERE r.event_id = ? AND r.role = 'judge'", event.id).map((j) => [j.id, j.name]),
  );
  return { event, outcome, ranking, judgeNames };
}

export function organizerResults(db: Db, actor: Actor, eventId: string): Computed {
  requireOrganizer(db, actor, eventId);
  return compute(db, getEvent(db, eventId)!);
}

export interface Publication {
  id: string;
  event_id: string;
  method: string;
  payload: string;
  payload_hash: string;
  published_at: string;
  retracted_at: string | null;
}

export interface PublicResults {
  event: { id: string; name: string };
  method: string;
  shrinkage_k: number;
  published_at: string;
  payload_hash: string;
  prizes: Array<{ name: string; track: string | null }>;
  ranking: Array<Omit<RankedProject, 'criteria'> & { criteria: Record<string, number> }>;
}

export function currentPublication(db: Db, eventId: string): Publication | undefined {
  return get<Publication>(db, 'SELECT * FROM result_publications WHERE event_id = ? AND retracted_at IS NULL ORDER BY published_at DESC LIMIT 1', eventId);
}

/**
 * Freezes the ranking into an immutable, hashed snapshot. The public only
 * ever sees aggregates; per-judge raw scores are never part of the payload.
 */
export function publish(db: Db, clock: Clock, actor: Actor, eventId: string): Publication {
  requireOrganizer(db, actor, eventId);
  const event = getEvent(db, eventId)!;
  if (event.results_published_at) throw conflict('Results are already published. Retract first to republish.', 'already_published');
  const { ranking } = compute(db, event);
  if (!ranking.some((r) => r.reviews > 0)) throw conflict('There are no scores to publish yet.', 'nothing_to_publish');
  const now = iso(clock.now());
  const trackNames = new Map(all<{ id: string; name: string }>(db, 'SELECT id, name FROM tracks WHERE event_id = ?', eventId).map((t) => [t.id, t.name]));
  const payload: PublicResults = {
    event: { id: event.id, name: event.name },
    method: event.normalization,
    shrinkage_k: event.shrinkage_k,
    published_at: now,
    payload_hash: '',
    prizes: prizes(db, eventId).map((p) => ({ name: p.name, track: p.track_id ? trackNames.get(p.track_id) ?? null : null })),
    ranking,
  };
  const body = JSON.stringify({ ...payload, payload_hash: undefined });
  const hash = sha256(body);
  return tx(db, () => {
    const id = newId('pub');
    run(db, 'INSERT INTO result_publications (id, event_id, method, payload, payload_hash, published_by, published_at) VALUES (?, ?, ?, ?, ?, ?, ?)', id, eventId, event.normalization, body, hash, actor.user!.id, now);
    run(db, 'UPDATE events SET results_published_at = ? WHERE id = ?', now, eventId);
    audit(db, { actor, eventId, action: 'results.publish', subjectType: 'publication', subjectId: id, detail: { hash, projects: ranking.length, method: event.normalization }, at: now });
    return get<Publication>(db, 'SELECT * FROM result_publications WHERE id = ?', id)!;
  });
}

export function retract(db: Db, clock: Clock, actor: Actor, eventId: string, reason: string): void {
  requireOrganizer(db, actor, eventId);
  const pub = currentPublication(db, eventId);
  if (!pub) throw notFound('Nothing is published.');
  tx(db, () => {
    const now = iso(clock.now());
    run(db, 'UPDATE result_publications SET retracted_at = ? WHERE id = ?', now, pub.id);
    run(db, 'UPDATE events SET results_published_at = NULL WHERE id = ?', eventId);
    audit(db, { actor, eventId, action: 'results.retract', subjectType: 'publication', subjectId: pub.id, detail: { reason: reason.slice(0, 300) }, at: now });
  });
}

/** Public results: only after publication, and only the frozen snapshot. */
export function publicResults(db: Db, actor: Actor, eventIdOrSlug: string): PublicResults {
  const event = loadEvent(db, actor, eventIdOrSlug);
  const pub = currentPublication(db, event.id);
  if (!pub) {
    if (isOrganizer(db, actor, event.id)) throw forbidden('Results are not published yet. Use the organizer preview.', 'results_unpublished');
    throw forbidden('Results have not been published yet.', 'results_unpublished');
  }
  return { ...(JSON.parse(pub.payload) as PublicResults), payload_hash: pub.payload_hash };
}

/** Feedback for a team after publication: their aggregate plus anonymised judge comments. */
export function teamFeedback(db: Db, eventId: string, projectId: string): { comments: string[] } {
  if (!currentPublication(db, eventId)) return { comments: [] };
  return {
    comments: all<{ comment: string }>(db, "SELECT comment FROM scores WHERE project_id = ? AND comment <> '' ORDER BY updated_at", projectId).map((r) => r.comment),
  };
}
