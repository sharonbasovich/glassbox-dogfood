import { type Db, all, get, run, tx } from '../db/index.ts';
import { newId, randomToken, str, badRequest, notFound, forbidden, conflict, iso, type Clock } from '../util.ts';
import type { Actor, User } from './auth.ts';
import { eventRoles, isOrganizer, requireUser, teamMembership } from './authz.ts';
import { audit } from './audit.ts';
import { getEvent, phase } from './events.ts';

export interface Team { id: string; event_id: string; name: string; invite_code: string; created_at: string }
export interface Member { user_id: string; name: string; email: string; role: 'owner' | 'member'; joined_at: string }

export function getTeam(db: Db, id: string): Team | undefined {
  return get<Team>(db, 'SELECT id, event_id, name, invite_code, created_at FROM teams WHERE id = ?', id);
}

export function members(db: Db, teamId: string): Member[] {
  return all<Member>(
    db,
    `SELECT m.user_id, u.name, u.email, m.role, m.joined_at FROM team_members m JOIN users u ON u.id = m.user_id
      WHERE m.team_id = ? ORDER BY m.role DESC, m.joined_at`,
    teamId,
  );
}

export function myTeam(db: Db, user: User | null, eventId: string): Team | undefined {
  const m = teamMembership(db, user?.id, eventId);
  return m ? getTeam(db, m.team_id) : undefined;
}

function assertCanParticipate(db: Db, userId: string, eventId: string): void {
  const roles = eventRoles(db, userId, eventId);
  if (roles.has('judge')) throw forbidden('Judges cannot join teams in an event they judge.', 'judge_conflict');
  if (roles.has('organizer')) throw forbidden('Organizers cannot compete in their own event.', 'organizer_conflict');
}

function assertTeamsMutable(db: Db, clock: Clock, eventId: string): void {
  const e = getEvent(db, eventId);
  if (!e) throw notFound('No such event.');
  const p = phase(e, clock.now());
  if (p !== 'open' && p !== 'upcoming') throw forbidden('Teams are locked once submissions close.', 'teams_locked');
}

export function addMember(db: Db, clock: Clock, team: Team, user: User, role: 'owner' | 'member'): void {
  const now = iso(clock.now());
  run(db, 'INSERT INTO team_members (team_id, event_id, user_id, role, joined_at) VALUES (?, ?, ?, ?, ?)', team.id, team.event_id, user.id, role, now);
  run(db, "INSERT OR IGNORE INTO event_roles (event_id, user_id, role, created_at) VALUES (?, ?, 'participant', ?)", team.event_id, user.id, now);
}

export function createTeam(db: Db, clock: Clock, actor: Actor, eventId: string, input: Record<string, unknown>): Team {
  const user = requireUser(actor);
  assertTeamsMutable(db, clock, eventId);
  assertCanParticipate(db, user.id, eventId);
  if (teamMembership(db, user.id, eventId)) throw conflict('You are already on a team for this event.', 'already_on_team');
  const name = str(input, 'name', { max: 80 });
  if (get(db, 'SELECT 1 FROM teams WHERE event_id = ? AND name = ? COLLATE NOCASE', eventId, name)) throw conflict('That team name is taken.', 'team_name_taken');
  return tx(db, () => {
    const team: Team = { id: newId('tm'), event_id: eventId, name, invite_code: randomToken('inv', 12), created_at: iso(clock.now()) };
    run(db, 'INSERT INTO teams (id, event_id, name, invite_code, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)', team.id, eventId, name, team.invite_code, user.id, team.created_at);
    addMember(db, clock, team, user, 'owner');
    audit(db, { actor, eventId, action: 'team.create', subjectType: 'team', subjectId: team.id, detail: { name }, at: team.created_at });
    return team;
  });
}

export function teamByInvite(db: Db, code: string): Team | undefined {
  return get<Team>(db, 'SELECT id, event_id, name, invite_code, created_at FROM teams WHERE invite_code = ?', code);
}

export function joinByInvite(db: Db, clock: Clock, actor: Actor, code: string): Team {
  const user = requireUser(actor);
  const team = teamByInvite(db, code);
  if (!team) throw notFound('This invite link is invalid or has been rotated.');
  const event = getEvent(db, team.event_id)!;
  assertTeamsMutable(db, clock, team.event_id);
  assertCanParticipate(db, user.id, team.event_id);
  const current = teamMembership(db, user.id, team.event_id);
  if (current?.team_id === team.id) return team;
  if (current) throw conflict('You are already on another team for this event. Leave it first.', 'already_on_team');
  if (members(db, team.id).length >= event.max_team_size) throw conflict(`Teams are limited to ${event.max_team_size} people.`, 'team_full');
  return tx(db, () => {
    addMember(db, clock, team, user, 'member');
    audit(db, { actor, eventId: team.event_id, action: 'team.join', subjectType: 'team', subjectId: team.id, detail: { via: 'invite_link' }, at: iso(clock.now()) });
    return team;
  });
}

export function leaveTeam(db: Db, clock: Clock, actor: Actor, teamId: string): void {
  const user = requireUser(actor);
  const team = getTeam(db, teamId);
  if (!team) throw notFound();
  assertTeamsMutable(db, clock, team.event_id);
  const m = teamMembership(db, user.id, team.event_id);
  if (m?.team_id !== teamId) throw forbidden('You are not on this team.', 'not_member');
  const rest = members(db, teamId).filter((x) => x.user_id !== user.id);
  tx(db, () => {
    run(db, 'DELETE FROM team_members WHERE team_id = ? AND user_id = ?', teamId, user.id);
    run(db, "DELETE FROM event_roles WHERE event_id = ? AND user_id = ? AND role = 'participant'", team.event_id, user.id);
    if (rest.length === 0) {
      if (get(db, "SELECT 1 FROM projects WHERE team_id = ? AND status = 'submitted'", teamId)) throw conflict('The last member cannot leave a team that has submitted.', 'team_has_submission');
      run(db, 'DELETE FROM teams WHERE id = ?', teamId);
    } else if (m.role === 'owner') {
      run(db, "UPDATE team_members SET role = 'owner' WHERE team_id = ? AND user_id = ?", teamId, rest[0]!.user_id);
    }
    audit(db, { actor, eventId: team.event_id, action: 'team.leave', subjectType: 'team', subjectId: teamId, at: iso(clock.now()) });
  });
}

export function rotateInvite(db: Db, clock: Clock, actor: Actor, teamId: string): Team {
  const user = requireUser(actor);
  const team = getTeam(db, teamId);
  if (!team) throw notFound();
  const m = teamMembership(db, user.id, team.event_id);
  if (m?.team_id !== teamId && !isOrganizer(db, actor, team.event_id)) throw forbidden('Only team members can rotate the invite link.', 'not_member');
  return tx(db, () => {
    const code = randomToken('inv', 12);
    run(db, 'UPDATE teams SET invite_code = ? WHERE id = ?', code, teamId);
    audit(db, { actor, eventId: team.event_id, action: 'team.invite_rotate', subjectType: 'team', subjectId: teamId, at: iso(clock.now()) });
    return { ...team, invite_code: code };
  });
}

export function listTeams(db: Db, eventId: string): Array<Team & { size: number; project_id: string | null }> {
  return all(
    db,
    `SELECT t.id, t.event_id, t.name, t.invite_code, t.created_at,
            (SELECT COUNT(*) FROM team_members m WHERE m.team_id = t.id) size,
            (SELECT p.id FROM projects p WHERE p.team_id = t.id AND p.duplicate_of IS NULL) project_id
       FROM teams t WHERE t.event_id = ? ORDER BY t.name`,
    eventId,
  );
}

