import { type Db, all } from '../db/index.ts';
import type { Actor } from './auth.ts';
import { requireOrganizer } from './authz.ts';
import { criteria, getEvent } from './events.ts';
import { compute } from './results.ts';

/** RFC 4180 quoting plus a guard against spreadsheet formula injection. */
export function cell(v: unknown): string {
  let s = v == null ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(header: string[], rows: unknown[][]): string {
  return [header, ...rows].map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n';
}

/** One row per review: raw values, weighted total, normalized total and the judge calibration used. */
export function scoresCsv(db: Db, actor: Actor, eventId: string): string {
  requireOrganizer(db, actor, eventId);
  const event = getEvent(db, eventId)!;
  const rubric = criteria(db, eventId);
  const { outcome } = compute(db, event);
  const adj = new Map(outcome.reviews.map((r) => [`${r.judgeId}|${r.projectId}`, r]));
  const cal = new Map(outcome.judges.map((j) => [j.judgeId, j]));
  const rows = all<{ id: string; judge_id: string; judge_name: string; project_id: string; title: string; team: string; track: string | null; duplicate_of: string | null; comment: string; updated_at: string }>(
    db,
    `SELECT s.id, s.judge_id, u.name judge_name, s.project_id, p.title, t.name team, tr.name track, p.duplicate_of, s.comment, s.updated_at
       FROM scores s JOIN users u ON u.id = s.judge_id JOIN projects p ON p.id = s.project_id JOIN teams t ON t.id = p.team_id
       LEFT JOIN tracks tr ON tr.id = p.track_id WHERE s.event_id = ? ORDER BY p.title, u.name`,
    eventId,
  );
  const values = new Map<string, Map<string, number>>();
  for (const v of all<{ score_id: string; criterion_id: string; value: number }>(db, 'SELECT v.score_id, v.criterion_id, v.value FROM score_values v JOIN scores s ON s.id = v.score_id WHERE s.event_id = ?', eventId)) {
    if (!values.has(v.score_id)) values.set(v.score_id, new Map());
    values.get(v.score_id)!.set(v.criterion_id, v.value);
  }
  return toCsv(
    ['event_id', 'project_id', 'project_title', 'team', 'track', 'judge_id', 'judge_name', ...rubric.map((c) => `${c.key} (w=${c.weight})`), 'weighted_total_0_100', 'normalized_0_100', 'z', 'judge_offset', 'judge_spread', 'excluded_reason', 'comment', 'updated_at'],
    rows.map((r) => {
      const o = adj.get(`${r.judge_id}|${r.project_id}`);
      const j = cal.get(r.judge_id);
      return [
        eventId, r.project_id, r.title, r.team, r.track, r.judge_id, r.judge_name,
        ...rubric.map((c) => values.get(r.id)?.get(c.id) ?? ''),
        o?.raw ?? '', o?.adjusted ?? '', o?.z ?? '', j?.offset ?? '', j?.spread ?? '',
        r.duplicate_of ? `duplicate_of:${r.duplicate_of}` : '', r.comment, r.updated_at,
      ];
    }),
  );
}

export function resultsCsv(db: Db, actor: Actor, eventId: string): string {
  requireOrganizer(db, actor, eventId);
  const event = getEvent(db, eventId)!;
  const rubric = criteria(db, eventId);
  const { ranking } = compute(db, event);
  return toCsv(
    ['rank', 'raw_rank', 'project_id', 'title', 'team', 'track', 'reviews', 'raw_0_100', 'adjusted_0_100', 'stderr', ...rubric.map((c) => `mean_${c.key}`)],
    ranking.map((r) => [r.rank, r.raw_rank, r.project_id, r.title, r.team, r.track, r.reviews, r.raw, r.adjusted, r.stderr, ...rubric.map((c) => r.criteria[c.key] ?? '')]),
  );
}

export function projectsCsv(db: Db, actor: Actor, eventId: string): string {
  requireOrganizer(db, actor, eventId);
  const rows = all<Record<string, string | null>>(
    db,
    `SELECT p.id, p.title, p.summary, t.name team, tr.name track, p.status, p.submitted_at, p.repo_url, p.demo_url, p.duplicate_of,
            (SELECT group_concat(u.email, ' ') FROM team_members m JOIN users u ON u.id = m.user_id WHERE m.team_id = t.id) members
       FROM projects p JOIN teams t ON t.id = p.team_id LEFT JOIN tracks tr ON tr.id = p.track_id WHERE p.event_id = ? ORDER BY p.title`,
    eventId,
  );
  const cols = ['id', 'title', 'summary', 'team', 'track', 'status', 'submitted_at', 'repo_url', 'demo_url', 'duplicate_of', 'members'];
  return toCsv(cols, rows.map((r) => cols.map((c) => r[c])));
}
