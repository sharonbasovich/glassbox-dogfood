import { Router } from '../http/router.ts';
import type { Ctx } from './ctx.ts';
import { h, fmtDate, csrfField, empty, phaseBadge } from './html.ts';
import { view, back, needLogin } from './common.ts';
import { eventRoles, teamMembership } from '../services/authz.ts';
import { loadEvent, phase, tracks } from '../services/events.ts';
import { createTeam, leaveTeam, members, myTeam, rotateInvite } from '../services/teams.ts';
import { createProject, effectiveClose, teamProject, updateProject } from '../services/projects.ts';
import { judgeQueue, ownScores, recuse, upsertScore } from '../services/judging.ts';
import { criteria } from '../services/events.ts';
import { notify } from '../services/live.ts';
import { forbidden, notFound } from '../util.ts';

export function teamRoutes(r: Router<Ctx>): void {
  r.on('GET', '/e/:event/team', (req, ctx) => {
    if (!ctx.actor.user) return needLogin(req);
    const e = loadEvent(ctx.db, ctx.actor, req.params.event!);
    const ph = phase(e, ctx.clock.now());
    const team = myTeam(ctx.db, ctx.actor.user, e.id);
    const crumbs: Array<[string, string]> = [[`/e/${e.slug}`, e.name]];
    if (!team) {
      const roles = eventRoles(ctx.db, ctx.actor.user.id, e.id);
      if (roles.has('judge') || roles.has('organizer')) return view(req, ctx, { title: 'Team', crumbs }, empty('Judges and organizers cannot compete in this event.'));
      if (ph !== 'open' && ph !== 'upcoming') return view(req, ctx, { title: 'Team', crumbs }, empty('Teams are locked: submissions have closed.'));
      return view(req, ctx, { title: 'Create a team', crumbs }, h`<h1>Create a team</h1>
<p class="muted">Solo? A team of one is fine. To join an existing team, ask a member for their invite link.</p>
<form class="stack card" method="post" action="/e/${e.slug}/team">${csrfField(ctx.actor)}<label>Team name<input name="name" required maxlength="80"></label><button>Create team</button></form>`);
    }
    const m = members(ctx.db, team.id);
    const p = teamProject(ctx.db, team.id);
    const invite = `/join/${team.invite_code}`;
    return view(req, ctx, { title: team.name, crumbs }, h`<div>${phaseBadge(ph)}</div><h1>${team.name}</h1>
<div class="cols"><div><div class="card"><h3>Members (${m.length}/${e.max_team_size})</h3><ul>${m.map((x) => h`<li>${x.name} <span class="muted small">${x.email}${x.role === 'owner' ? ' · owner' : ''}</span></li>`)}</ul></div>
<div class="card"><h3>Project</h3>${p ? h`<p><a href="/projects/${p.id}"><b>${p.title}</b></a> <span class="badge ${p.status === 'submitted' ? 'ok' : 'draft'}">${p.status}</span></p>` : h`<p class="muted">No project yet.</p>`}
${ph === 'open' ? h`<a class="btn" href="/e/${e.slug}/submit">${p ? 'Edit project' : 'Start your project'}</a>` : ''}</div></div>
<aside>${ph === 'open' || ph === 'upcoming' ? h`<div class="card"><h3>Invite teammates</h3><p class="small muted">Anyone with this link can join until the team is full or submissions close.</p>
<div class="copy"><input readonly value="${invite}" id="invite" aria-label="Invite link" onclick="this.value=location.origin+'${invite}';this.select()"><button class="small secondary" type="button" onclick="const i=document.getElementById('invite');i.value=location.origin+'${invite}';navigator.clipboard&&navigator.clipboard.writeText(i.value);this.textContent='Copied'">Copy</button></div>
<form method="post" action="/e/${e.slug}/team/rotate" style="margin-top:8px">${csrfField(ctx.actor)}<button class="small secondary">Rotate link</button></form></div>
<form method="post" action="/e/${e.slug}/team/leave" onsubmit="return confirm('Leave this team?')">${csrfField(ctx.actor)}<button class="danger small">Leave team</button></form>` : h`<div class="card muted small">Teams are locked after submissions close.</div>`}</aside></div>`);
  });

  r.on('POST', '/e/:event/team', async (req, ctx) => {
    const e = loadEvent(ctx.db, ctx.actor, req.params.event!);
    const t = createTeam(ctx.db, ctx.clock, ctx.actor, e.id, await req.body());
    return back(`/e/${e.slug}/team`, `Team ${t.name} created. Share the invite link with teammates.`);
  });
  r.on('POST', '/e/:event/team/rotate', (req, ctx) => {
    const e = loadEvent(ctx.db, ctx.actor, req.params.event!);
    const t = myTeam(ctx.db, ctx.actor.user, e.id);
    if (!t) throw notFound();
    rotateInvite(ctx.db, ctx.clock, ctx.actor, t.id);
    return back(`/e/${e.slug}/team`, 'New invite link generated; the old one no longer works.');
  });
  r.on('POST', '/e/:event/team/leave', (req, ctx) => {
    const e = loadEvent(ctx.db, ctx.actor, req.params.event!);
    const t = myTeam(ctx.db, ctx.actor.user, e.id);
    if (!t) throw notFound();
    leaveTeam(ctx.db, ctx.clock, ctx.actor, t.id);
    return back(`/e/${e.slug}`, 'You left the team.');
  });

  r.on('GET', '/e/:event/submit', (req, ctx) => {
    if (!ctx.actor.user) return needLogin(req);
    const e = loadEvent(ctx.db, ctx.actor, req.params.event!);
    const m = teamMembership(ctx.db, ctx.actor.user.id, e.id);
    const crumbs: Array<[string, string]> = [[`/e/${e.slug}`, e.name]];
    if (!m) return view(req, ctx, { title: 'Submit', crumbs }, empty('Create or join a team first.', h`<a class="btn" href="/e/${e.slug}/team">Team</a>`));
    const p = teamProject(ctx.db, m.team_id);
    const close = effectiveClose(ctx.db, e, m.team_id);
    const now = ctx.clock.now().toISOString();
    const open = now >= e.submissions_open_at && now < close;
    const trk = tracks(ctx.db, e.id);
    const v = (k: 'title' | 'summary' | 'description' | 'repo_url' | 'demo_url') => p?.[k] ?? '';
    return view(req, ctx, { title: p ? 'Edit project' : 'New project', crumbs }, h`<h1>${p ? 'Your project' : 'Start your project'}</h1>
<p class="muted">Deadline: <b>${fmtDate(close)}</b>. Save a draft anytime; submit when ready. You can keep editing (or withdraw) until the deadline.${p ? h` Status: <span class="badge ${p.status === 'submitted' ? 'ok' : 'draft'}">${p.status}</span>` : ''}</p>
${open ? '' : h`<div class="flash err">Submissions are closed for your team. The form is read-only.</div>`}
<form class="stack card" method="post" action="/e/${e.slug}/submit">${csrfField(ctx.actor)}
<fieldset ${open ? '' : 'disabled'} style="border:0;padding:0;margin:0;display:grid;gap:12px">
<label>Title<input name="title" required maxlength="120" value="${v('title')}"></label>
<label>One-line summary <span class="hint">Shown in the gallery. Max 280 characters.</span><input name="summary" maxlength="280" value="${v('summary')}"></label>
<label>Track<select name="track_id"><option value="">No track</option>${trk.map((t) => h`<option value="${t.id}" ${p?.track_id === t.id ? 'selected' : ''}>${t.name}</option>`)}</select></label>
<label>Description<textarea name="description" maxlength="20000" rows="8">${v('description')}</textarea></label>
<div class="row"><label>Repository URL<input name="repo_url" type="url" value="${v('repo_url')}" placeholder="https://"></label><label>Demo URL<input name="demo_url" type="url" value="${v('demo_url')}" placeholder="https://"></label></div>
<div class="row" style="flex:0"><button name="action" value="save" class="secondary">Save draft</button><button name="action" value="submit">${p?.status === 'submitted' ? 'Save and keep submitted' : 'Submit project'}</button>
${p?.status === 'submitted' ? h`<button name="action" value="unsubmit" class="danger">Withdraw to draft</button>` : ''}</div></fieldset></form>`);
  });

  r.on('POST', '/e/:event/submit', async (req, ctx) => {
    const e = loadEvent(ctx.db, ctx.actor, req.params.event!);
    const m = teamMembership(ctx.db, ctx.actor.user?.id, e.id);
    if (!m) throw forbidden('Join or create a team first.', 'no_team');
    const b = await req.body();
    const existing = teamProject(ctx.db, m.team_id);
    const p = existing ? updateProject(ctx.db, ctx.clock, ctx.actor, existing.id, b) : createProject(ctx.db, ctx.clock, ctx.actor, e.id, b);
    notify(e.id, 'project');
    const msg = b.action === 'submit' ? 'Submitted. You can still edit until the deadline.' : b.action === 'unsubmit' ? 'Withdrawn to draft. Remember to submit again before the deadline.' : 'Draft saved.';
    return back(`/e/${e.slug}/submit`, p.status === 'submitted' && b.action === 'save' ? 'Saved. Your project is still submitted.' : msg);
  });

  // ---- judging ----
  r.on('GET', '/e/:event/judge', (req, ctx) => {
    if (!ctx.actor.user) return needLogin(req);
    const e = loadEvent(ctx.db, ctx.actor, req.params.event!);
    const q = judgeQueue(ctx.db, ctx.actor, e.id);
    const done = q.filter((x) => x.score_id).length;
    const ph = phase(e, ctx.clock.now());
    return view(req, ctx, { title: 'Judging', crumbs: [[`/e/${e.slug}`, e.name]] }, h`<div>${phaseBadge(ph)}</div><h1>Your judging queue</h1>
<p class="muted">${done} of ${q.length} scored. You only see your own scores; other judges cannot see yours. ${ph === 'open' ? 'Scoring opens when submissions close.' : ''}</p>
<div class="bar-meter" aria-label="progress"><i style="width:${q.length ? Math.round((100 * done) / q.length) : 0}%"></i></div>
${q.length ? h`<div class="table-wrap" style="margin-top:14px"><table><thead><tr><th>Project</th><th>Team</th><th>Track</th><th>Status</th><th></th></tr></thead><tbody>
${q.map((x) => h`<tr><td><a href="/projects/${x.project_id}">${x.title}</a><div class="small muted">${x.summary}</div></td><td>${x.team_name}</td><td>${x.track_name ?? ''}</td><td>${x.score_id ? h`<span class="badge ok">scored</span>` : h`<span class="badge">to do</span>`}</td>
<td><a class="btn small ${x.score_id ? 'secondary' : ''}" href="/e/${e.slug}/judge/${x.project_id}">${x.score_id ? 'Revise' : 'Score'}</a></td></tr>`)}</tbody></table></div>` : empty('Nothing assigned to you yet.')}`);
  });

  r.on('GET', '/e/:event/judge/:project', (req, ctx) => {
    if (!ctx.actor.user) return needLogin(req);
    const e = loadEvent(ctx.db, ctx.actor, req.params.event!);
    const q = judgeQueue(ctx.db, ctx.actor, e.id);
    const item = q.find((x) => x.project_id === req.params.project);
    if (!item) throw forbidden('This project is not assigned to you.', 'not_assigned');
    const mine = ownScores(ctx.db, ctx.actor.user.id, e.id).find((s) => s.project_id === item.project_id);
    const rub = criteria(ctx.db, e.id);
    const wsum = rub.reduce((s, c) => s + c.weight, 0) || 1;
    const next = q.find((x) => !x.score_id && x.project_id !== item.project_id);
    const locked = phase(e, ctx.clock.now()) === 'published';
    return view(req, ctx, { title: `Score ${item.title}`, crumbs: [[`/e/${e.slug}`, e.name], [`/e/${e.slug}/judge`, 'Queue']] }, h`<h1>${item.title}</h1>
<p class="muted">${item.team_name}${item.track_name ? ` · ${item.track_name}` : ''} · <a href="/projects/${item.project_id}" target="_blank">Full project page</a>${item.repo_url ? h` · <a href="${item.repo_url}" rel="noopener nofollow" target="_blank">Repo</a>` : ''}${item.demo_url ? h` · <a href="${item.demo_url}" rel="noopener nofollow" target="_blank">Demo</a>` : ''}</p>
<p>${item.summary}</p>
${locked ? h`<div class="flash">Results are published; scores are locked and shown read-only.</div>` : ''}
<form class="stack card" method="post" action="/e/${e.slug}/judge/${item.project_id}">${csrfField(ctx.actor)}<fieldset ${locked ? 'disabled' : ''} style="border:0;padding:0;margin:0;display:grid;gap:12px">
${rub.map((c) => h`<fieldset style="border:0;padding:0;margin:0"><legend><b>${c.name}</b> <span class="muted small">weight ${Math.round((100 * c.weight) / wsum)}% · ${c.description}</span></legend>
<div class="scale">${Array.from({ length: c.scale_max - c.scale_min + 1 }, (_, i) => c.scale_min + i).map((n) => h`<label><input type="radio" name="${c.key}" value="${n}" required ${mine?.values[c.key] === n ? 'checked' : ''}> ${n}</label>`)}</div></fieldset>`)}
<label>Comment for the team <span class="hint">Shared anonymously with the team after results are published.</span><textarea name="comment" maxlength="4000">${mine?.comment ?? ''}</textarea></label>
<input type="hidden" name="next" value="${next ? next.project_id : ''}">
${locked ? '' : h`<div class="row" style="flex:0"><button>${mine ? 'Update score' : 'Save score'}${next ? ' and next' : ''}</button></div>`}</fieldset></form>
${locked ? '' : h`<details class="card"><summary>Conflict of interest?</summary><form method="post" action="/e/${e.slug}/judge/${item.project_id}/recuse" class="stack" style="margin-top:10px">${csrfField(ctx.actor)}
<label>Reason<input name="reason" required maxlength="300" placeholder="e.g. I mentor this team"></label><button class="danger">Recuse from this project</button></form></details>`}`);
  });

  r.on('POST', '/e/:event/judge/:project', async (req, ctx) => {
    const e = loadEvent(ctx.db, ctx.actor, req.params.event!);
    const b = await req.body();
    upsertScore(ctx.db, ctx.clock, ctx.actor, e.id, req.params.project!, b);
    notify(e.id, 'score');
    const next = typeof b.next === 'string' && b.next ? b.next : null;
    return back(next ? `/e/${e.slug}/judge/${encodeURIComponent(next)}` : `/e/${e.slug}/judge`, 'Score saved.');
  });

  r.on('POST', '/e/:event/judge/:project/recuse', async (req, ctx) => {
    const e = loadEvent(ctx.db, ctx.actor, req.params.event!);
    const b = await req.body();
    recuse(ctx.db, ctx.clock, ctx.actor, e.id, req.params.project!, String(b.reason ?? ''));
    notify(e.id, 'assign');
    return back(`/e/${e.slug}/judge`, 'Recusal recorded. The organizer will reassign the project.');
  });
}
