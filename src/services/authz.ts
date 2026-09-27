/**
 * The single place that decides who may do what. Every route calls one of
 * these before touching data; the UI hiding a button is never the control.
 */
import { type Db, all, get } from '../db/index.ts';
import { forbidden, unauthorized } from '../util.ts';
import type { Actor, User } from './auth.ts';

export type EventRole = 'organizer' | 'judge' | 'participant';

export function eventRoles(db: Db, userId: string | undefined, eventId: string): Set<EventRole> {
  if (!userId) return new Set();
  return new Set(all<{ role: EventRole }>(db, 'SELECT role FROM event_roles WHERE event_id = ? AND user_id = ?', eventId, userId).map((r) => r.role));
}

export function isAdmin(actor: Actor): boolean {
  return actor.user?.platform_role === 'admin';
}

export function requireUser(actor: Actor): User {
  if (!actor.user) throw unauthorized();
  return actor.user;
}

export function canCreateEvents(actor: Actor): boolean {
  return actor.user?.platform_role === 'organizer' || actor.user?.platform_role === 'admin';
}

export function isOrganizer(db: Db, actor: Actor, eventId: string): boolean {
  return isAdmin(actor) || eventRoles(db, actor.user?.id, eventId).has('organizer');
}

export function requireOrganizer(db: Db, actor: Actor, eventId: string): User {
  const user = requireUser(actor);
  if (!isOrganizer(db, actor, eventId)) throw forbidden('Only organizers of this event can do that.', 'not_organizer');
  return user;
}

export function isJudge(db: Db, actor: Actor, eventId: string): boolean {
  return eventRoles(db, actor.user?.id, eventId).has('judge');
}

export function requireJudge(db: Db, actor: Actor, eventId: string): User {
  const user = requireUser(actor);
  if (!isJudge(db, actor, eventId)) throw forbidden('You are not a judge for this event.', 'not_judge');
  return user;
}

/** Judges in any event (used for cross-event "my scores" endpoints). */
export function judgedEventIds(db: Db, userId: string): string[] {
  return all<{ event_id: string }>(db, "SELECT event_id FROM event_roles WHERE user_id = ? AND role = 'judge'", userId).map((r) => r.event_id);
}

/**
 * A judge's raw scores are visible to that judge and to organizers of the
 * event. Never to other judges, participants or visitors, and publishing
 * results does not change that (only aggregates are published).
 */
export function assertCanReadJudgeScores(db: Db, actor: Actor, judgeId: string, eventId: string): void {
  const user = requireUser(actor);
  if (user.id === judgeId && isJudge(db, actor, eventId)) return;
  if (isOrganizer(db, actor, eventId)) return;
  throw forbidden("You may only read your own scores.", 'peer_scores_forbidden');
}

export function teamMembership(db: Db, userId: string | undefined, eventId: string): { team_id: string; role: 'owner' | 'member' } | undefined {
  if (!userId) return undefined;
  return get(db, 'SELECT team_id, role FROM team_members WHERE user_id = ? AND event_id = ?', userId, eventId);
}
