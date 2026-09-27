import { Router, json, csvReply, type Req } from '../http/router.ts';
import type { Ctx } from './ctx.ts';
import { unauthorized, forbidden, notFound, badRequest, str, iso } from '../util.ts';
import { createSession, findUserByEmail, verifyPassword } from '../services/auth.ts';
import { isOrganizer, requireOrganizer, requireUser, isAdmin, eventRoles } from '../services/authz.ts';
import { createEvent, criteria, listEvents, loadEvent, phase, prizes, saveCriteria, tracks, updateEvent } from '../services/events.ts';
import { createTeam, joinByInvite, members, myTeam } from '../services/teams.ts';
import { createProject, gallery, loadProjectFor, updateProject } from '../services/projects.ts';
import { autoAssign, inviteJudge, judgeQueue, progress, readJudgeScores, upsertScore } from '../services/judging.ts';
import { organizerResults, publicResults, publish } from '../services/results.ts';
import { projectsCsv, resultsCsv, scoresCsv } from '../services/csv.ts';
import { eventAudit, verifyAuditChain } from '../services/audit.ts';
import { exportEvent, importBundle } from '../services/importer.ts';
import { notify } from '../services/live.ts';

const ev = (req: Req, ctx: Ctx) => loadEvent(ctx.db, ctx.actor, req.params.event!);

/** JSON API. Every handler delegates to a service that performs the authorization check before touching data. */
export function apiRoutes(r: Router<Ctx>): void {
  r.on('GET', '/healthz', (_req, ctx) => json(200, { ok: true, time: iso(ctx.clock.now()) }));

  r.on('POST', '/api/login', async (req, ctx) => {
    const b = await req.body();
    const user = findUserByEmail(ctx.db, str(b, 'email', { max: 254 }));
    if (!user || !verifyPassword(String(b.password ?? ''), user.password_hash)) throw unauthorized('Wrong email or password.');
    return json(200, { token: createSession(ctx.db, ctx.clock, user.id, 'api', 'api-login'), user: { id: user.id, email: user.email, name: user.name } });
  });

  r.on('GET', '/api/me', (_req, ctx) => {
    const u = requireUser(ctx.actor);
    const roles = ctx.db.prepare('SELECT event_id, role FROM event_roles WHERE user_id = ? ORDER BY event_id').all(u.id);
    return json(200, { user: u, event_roles: roles });
  });

  r.on('GET', '/api/events', (_req, ctx) =>
    json(200, { events: listEvents(ctx.db, ctx.actor).map((e) => ({ ...e, phase: phase(e, ctx.clock.now()) })) }));

  r.on('POST', '/api/events', async (req, ctx) => json(201, { event: createEvent(ctx.db, ctx.clock, ctx.actor, await req.body()) }));

  r.on('GET', '/api/events/:event', (req, ctx) => {
    const e = ev(req, ctx);
    return json(200, { event: { ...e, phase: phase(e, ctx.clock.now()) }, tracks: tracks(ctx.db, e.id), prizes: prizes(ctx.db, e.id), criteria: criteria(ctx.db, e.id) });
  });

  r.on('PATCH', '/api/events/:event', async (req, ctx) => {
    const e = ev(req, ctx);
    return json(200, { event: updateEvent(ctx.db, ctx.clock, ctx.actor, e.id, { ...e, ...(await req.body()) }) });
  });

  r.on('PUT', '/api/events/:event/criteria', async (req, ctx) => {
    const e = ev(req, ctx);
    const b = await req.body();
    const rows = Array.isArray(b.criteria) ? b.criteria : Array.isArray(b.items) ? b.items : null;
    if (!rows) throw badRequest('Send {"criteria": [{name, weight, scale_min, scale_max}]}.');
    return json(200, { criteria: saveCriteria(ctx.db, ctx.clock, ctx.actor, e.id, rows as Array<Record<string, unknown>>) });
  });

  // Public gallery (JSON). The HTML gallery lives at /projects.
  r.on('GET', '/api/projects', (req, ctx) => {
    const q = req.query;
    const res = gallery(ctx.db, { q: q.get('q') ?? undefined, event: q.get('event') ?? undefined, track: q.get('track') ?? undefined, sort: (q.get('sort') as 'title') ?? undefined, page: Number(q.get('page')) || 1 });
    return json(200, res);
  });

  r.on('GET', '/api/projects/:id', (req, ctx) => json(200, { project: loadProjectFor(ctx.db, ctx.actor, req.params.id!) }));

  r.on('POST', '/api/events/:event/projects', async (req, ctx) => {
    requireUser(ctx.actor);
    const p = createProject(ctx.db, ctx.clock, ctx.actor, req.params.event!, await req.body());
    notify(p.event_id, 'project');
    return json(201, { project: p });
  });

  r.on('PATCH', '/api/projects/:id', async (req, ctx) => {
    const p = updateProject(ctx.db, ctx.clock, ctx.actor, req.params.id!, await req.body());
    notify(p.event_id, 'project');
    return json(200, { project: p });
  });

  r.on('GET', '/api/events/:event/team', (req, ctx) => {
    const e = ev(req, ctx);
    const t = myTeam(ctx.db, requireUser(ctx.actor), e.id);
    if (!t) throw notFound('You are not on a team for this event.');
    return json(200, { team: t, members: members(ctx.db, t.id) });
  });

  r.on('POST', '/api/events/:event/teams', async (req, ctx) => {
    const e = ev(req, ctx);
    return json(201, { team: createTeam(ctx.db, ctx.clock, ctx.actor, e.id, await req.body()) });
  });

  r.on('POST', '/api/join/:code', (req, ctx) => json(200, { team: joinByInvite(ctx.db, ctx.clock, ctx.actor, req.params.code!) }));

  // Judge isolation: /api/judges/me/scores for yourself; any other id is refused unless you organize that judge's event.
  r.on('GET', '/api/judges/:judge/scores', (req, ctx) =>
    json(200, readJudgeScores(ctx.db, ctx.actor, req.params.judge!, req.query.get('event'))));

  r.on('GET', '/api/events/:event/queue', (req, ctx) => json(200, { queue: judgeQueue(ctx.db, ctx.actor, ev(req, ctx).id) }));

  r.on('PUT', '/api/events/:event/scores/:project', async (req, ctx) => {
    const e = ev(req, ctx);
    const s = upsertScore(ctx.db, ctx.clock, ctx.actor, e.id, req.params.project!, await req.body());
    notify(e.id, 'score');
    return json(200, { score: s });
  });

  r.on('POST', '/api/events/:event/judges', async (req, ctx) => {
    const e = ev(req, ctx);
    const res = inviteJudge(ctx.db, ctx.clock, ctx.actor, e.id, await req.body());
    return json(201, res);
  });

  r.on('POST', '/api/events/:event/assignments/auto', async (req, ctx) => {
    const e = ev(req, ctx);
    const b = await req.body();
    const res = autoAssign(ctx.db, ctx.clock, ctx.actor, e.id, { maxPerJudge: b.max_per_judge ? Number(b.max_per_judge) : undefined });
    notify(e.id, 'assign');
    return json(200, res);
  });

  r.on('GET', '/api/events/:event/progress', (req, ctx) => json(200, progress(ctx.db, ctx.clock, ctx.actor, ev(req, ctx).id)));

  r.on('GET', '/api/events/:event/results/preview', (req, ctx) => {
    const c = organizerResults(ctx.db, ctx.actor, ev(req, ctx).id);
    return json(200, { method: c.outcome.method, k: c.outcome.k, global: { mean: c.outcome.globalMean, sd: c.outcome.globalSd }, judges: c.outcome.judges.map((j) => ({ ...j, name: c.judgeNames[j.judgeId] })), ranking: c.ranking });
  });

  r.on('POST', '/api/events/:event/publish', (req, ctx) => {
    const e = ev(req, ctx);
    const pub = publish(ctx.db, ctx.clock, ctx.actor, e.id);
    notify(e.id, 'publish');
    return json(200, { published_at: pub.published_at, payload_hash: pub.payload_hash });
  });

  r.on('GET', '/api/events/:event/results', (req, ctx) => json(200, publicResults(ctx.db, ctx.actor, req.params.event!)));

  const csv = (name: string, fn: typeof scoresCsv) => (req: Req, ctx: Ctx) => {
    const e = ev(req, ctx);
    return csvReply(`${e.slug}-${name}.csv`, fn(ctx.db, ctx.actor, e.id));
  };
  r.on('GET', '/api/events/:event/export/scores.csv', csv('scores', scoresCsv));
  r.on('GET', '/api/events/:event/export/results.csv', csv('results', resultsCsv));
  r.on('GET', '/api/events/:event/export/projects.csv', csv('projects', projectsCsv));
  r.on('GET', '/api/events/:event/export/bundle.json', (req, ctx) => {
    const e = ev(req, ctx);
    return json(200, exportEvent(ctx.db, ctx.actor, e.id), { 'content-disposition': `attachment; filename="${e.slug}-bundle.json"` });
  });

  r.on('POST', '/api/import', async (req, ctx) => {
    requireUser(ctx.actor);
    return json(201, importBundle(ctx.db, ctx.clock, ctx.actor, await req.body()));
  });

  r.on('GET', '/api/events/:event/audit', (req, ctx) => {
    const e = ev(req, ctx);
    requireOrganizer(ctx.db, ctx.actor, e.id);
    return json(200, { chain: verifyAuditChain(ctx.db), entries: eventAudit(ctx.db, e.id, Number(req.query.get('limit')) || 500) });
  });

  r.on('GET', '/api/audit/verify', (_req, ctx) => {
    if (!isAdmin(ctx.actor) && !ctx.actor.user) throw unauthorized();
    if (!isAdmin(ctx.actor)) throw forbidden('Admins only.');
    return json(200, verifyAuditChain(ctx.db));
  });

  r.on('GET', '/api/events/:event/roles', (req, ctx) => {
    const e = ev(req, ctx);
    return json(200, { roles: [...eventRoles(ctx.db, ctx.actor.user?.id, e.id)], organizer: isOrganizer(ctx.db, ctx.actor, e.id) });
  });
}
