import { Router, json, type Req } from '../http/router.ts';
import type { Ctx } from './ctx.ts';
import { h, fmtDate, csrfField, empty, phaseBadge, toLocalInput, type Html } from './html.ts';
import { view, back, needLogin } from './common.ts';
import { requireOrganizer, canCreateEvents, isAdmin, requireUser } from '../services/authz.ts';
import { type EventRow, addPrize, addTrack, createEvent, criteria, deleteTrackOrPrize, loadEvent, phase, prizes, saveCriteria, tracks, updateEvent } from '../services/events.ts';
import { eventProjects, grantExtension, resolveDuplicate } from '../services/projects.ts';
import { listTeams } from '../services/teams.ts';
import { assign, autoAssign, inviteJudge, judges, progress, removeJudge, unassign } from '../services/judging.ts';
import { currentPublication, organizerResults, publish, retract } from '../services/results.ts';
import { eventAudit, verifyAuditChain } from '../services/audit.ts';
import { importBundle } from '../services/importer.ts';
import { live, notify } from '../services/live.ts';
import { all, run } from '../db/index.ts';
import { forbidden, badRequest } from '../util.ts';
import { audit } from '../services/audit.ts';

const TABS = [['', 'Overview'], ['setup', 'Setup'], ['judges', 'Judges'], ['projects', 'Projects'], ['results', 'Results'], ['audit', 'Audit log']] as const;

function shell(req: Req, ctx: Ctx, e: EventRow, tab: string, body: Html) {
  return view(req, ctx, { title: `Manage ${e.name}`, wide: true, crumbs: [[`/e/${e.slug}`, e.name]] }, h`<div>${phaseBadge(phase(e, ctx.clock.now()))}</div><h1>${e.name} <span class="muted small">organizer</span></h1>
<nav class="tabs">${TABS.map(([k, label]) => h`<a class="${k === tab ? 'on' : ''}" href="/e/${e.slug}/manage${k ? `/${k}` : ''}">${label}</a>`)}</nav>${body}`);
}

function load(req: Req, ctx: Ctx): EventRow {
  const e = loadEvent(ctx.db, ctx.actor, req.params.event!);
  requireOrganizer(ctx.db, ctx.actor, e.id);
  return e;
}

const eventForm = (ctx: Ctx, e: Partial<EventRow> | null, action: string) => h`<form class="stack card" method="post" action="${action}">${csrfField(ctx.actor)}
<label>Name<input name="name" required maxlength="120" value="${e?.name ?? ''}"></label>
<label>Tagline<input name="tagline" maxlength="200" value="${e?.tagline ?? ''}"></label>
<label>Description<textarea name="description" maxlength="10000">${e?.description ?? ''}</textarea></label>
<div class="row"><label>Submissions open (UTC)<input type="datetime-local" name="submissions_open_at" required value="${toLocalInput(e?.submissions_open_at)}"></label>
<label>Submissions close (UTC)<input type="datetime-local" name="submissions_close_at" required value="${toLocalInput(e?.submissions_close_at)}"></label>
<label>Judging closes (UTC) <span class="hint">optional</span><input type="datetime-local" name="judging_close_at" value="${toLocalInput(e?.judging_close_at)}"></label></div>
<div class="row"><label>Max team size<input type="number" name="max_team_size" min="1" max="20" value="${e?.max_team_size ?? 4}"></label>
<label>Reviews per project<input type="number" name="reviews_per_project" min="1" max="20" value="${e?.reviews_per_project ?? 3}"></label>
<label>Calibration<select name="normalization"><option value="zscore_shrunk">Shrunk z-score (recommended)</option><option value="none" ${e?.normalization === 'none' ? 'selected' : ''}>None (raw weighted mean)</option></select></label>
<label>Visibility<select name="visibility"><option value="public">Public</option><option value="draft" ${e?.visibility === 'draft' ? 'selected' : ''}>Draft (organizers only)</option></select></label></div>
${e ? '' : h`<label>Tracks <span class="hint">one per line</span><textarea name="tracks" rows="3" placeholder="Open\nBest use of AI"></textarea></label>
<label>Prizes <span class="hint">one per line</span><textarea name="prizes" rows="3" placeholder="Grand prize\nPeople's choice"></textarea></label>`}
<button>${e ? 'Save settings' : 'Create event'}</button></form>`;

export function organizerRoutes(r: Router<Ctx>): void {
  r.on('GET', '/events/new', (req, ctx) => {
    if (!ctx.actor.user) return needLogin(req);
    if (!canCreateEvents(ctx.actor)) throw forbidden('Your account cannot create events. Ask an admin to make you an organizer.', 'cannot_create_events');
    const now = new Date(Math.ceil(ctx.clock.now().getTime() / 3600_000) * 3600_000);
    const draft = { submissions_open_at: now.toISOString(), submissions_close_at: new Date(now.getTime() + 48 * 3600_000).toISOString(), judging_close_at: new Date(now.getTime() + 72 * 3600_000).toISOString() };
    return view(req, ctx, { title: 'New event' }, h`<h1>Create an event</h1><p class="muted">You can change everything later. A default rubric (Functionality 40%, Quality 35%, Innovation 25%) is created; edit it under Setup.</p>${eventForm(ctx, { ...draft } as Partial<EventRow>, '/events')}
<h2>Or import</h2><form class="stack card" method="post" action="/events/import" enctype="application/x-www-form-urlencoded">${csrfField(ctx.actor)}<label>DOGFOOD fixtures.json or Glassbox bundle <span class="hint">Paste the JSON. Ids are kept when free; duplicates and conflicts are reported.</span><textarea name="bundle" rows="6" required></textarea></label><button class="secondary">Import</button></form>`);
  });
  r.on('POST', '/events', async (req, ctx) => {
    const e = createEvent(ctx.db, ctx.clock, ctx.actor, await req.body());
    return back(`/e/${e.slug}/manage`, 'Event created.');
  });
  r.on('POST', '/events/import', async (req, ctx) => {
    requireUser(ctx.actor);
    const b = await req.body();
    let parsed: unknown;
    try {
      parsed = JSON.parse(String(b.bundle ?? ''));
    } catch {
      throw badRequest('That is not valid JSON.');
    }
    const rep = importBundle(ctx.db, ctx.clock, ctx.actor, parsed);
    const e = loadEvent(ctx.db, ctx.actor, rep.event_id);
    return back(`/e/${e.slug}/manage`, `Imported ${rep.counts.projects} projects, ${rep.counts.scores} scores; ${rep.duplicates.length} duplicates flagged, ${rep.warnings.length} warnings.`);
  });

  r.on('GET', '/e/:event/manage', (req, ctx) => {
    if (!ctx.actor.user) return needLogin(req);
    const e = load(req, ctx);
    const p = progress(ctx.db, ctx.clock, ctx.actor, e.id);
    return shell(req, ctx, e, '', h`<p class="small muted"><span class="live-dot"></span>Live — updates as teams submit and judges score. <span id="gen">${fmtDate(p.generated_at)}</span></p>
<div id="live">${progressView(p)}</div>
<script>(()=>{const es=new EventSource('/e/${e.slug}/manage/live');es.onmessage=async()=>{const r=await fetch('/e/${e.slug}/manage/fragment');if(r.ok){document.getElementById('live').innerHTML=await r.text();document.getElementById('gen').textContent=new Date().toISOString().slice(0,19).replace('T',' ')+' UTC'}}})()</script>`);
  });

  r.on('GET', '/e/:event/manage/fragment', (req, ctx) => {
    const e = load(req, ctx);
    return { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, body: progressView(progress(ctx.db, ctx.clock, ctx.actor, e.id)).value };
  });

  r.on('GET', '/e/:event/manage/live', (req, ctx) => {
    const e = load(req, ctx);
    const res = req.res;
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
    res.write('retry: 3000\n\n');
    let pending: NodeJS.Timeout | null = null;
    const onEvent = (kind: string) => {
      if (pending) return;
      pending = setTimeout(() => { pending = null; res.write(`data: ${kind}\n\n`); }, 300);
    };
    const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
    live.on(`event:${e.id}`, onEvent);
    req.raw.on('close', () => { live.off(`event:${e.id}`, onEvent); clearInterval(ping); if (pending) clearTimeout(pending); });
    return { status: 200, streaming: true };
  });

  r.on('GET', '/e/:event/manage/progress.json', (req, ctx) => json(200, progress(ctx.db, ctx.clock, ctx.actor, load(req, ctx).id)));

  // ---- setup ----
  r.on('GET', '/e/:event/manage/setup', (req, ctx) => {
    const e = load(req, ctx);
    const trk = tracks(ctx.db, e.id);
    const prz = prizes(ctx.db, e.id);
    const rub = criteria(ctx.db, e.id);
    const wsum = rub.reduce((s, c) => s + c.weight, 0) || 1;
    const rows = [...rub, ...Array.from({ length: 2 }, () => null)];
    return shell(req, ctx, e, 'setup', h`<div class="cols"><div><h2>Event settings</h2>${eventForm(ctx, e, `/e/${e.slug}/manage/setup`)}
<h2>Scoring rubric</h2><form class="card" method="post" action="/e/${e.slug}/manage/rubric">${csrfField(ctx.actor)}
<p class="small muted">Weights are relative; they are shown to judges and teams as percentages. Criteria with scores cannot be removed or rescaled. Leave a row's name empty to remove it.</p>
<div class="table-wrap"><table><thead><tr><th>Criterion</th><th>Description</th><th>Weight</th><th>Min</th><th>Max</th><th>Share</th></tr></thead><tbody>
${rows.map((c, i) => h`<tr><td><input name="name_${i}" value="${c?.name ?? ''}" maxlength="80"><input type="hidden" name="key_${i}" value="${c?.key ?? ''}"></td><td><input name="description_${i}" value="${c?.description ?? ''}" maxlength="500"></td>
<td><input name="weight_${i}" type="number" step="any" min="0" value="${c?.weight ?? ''}" style="width:80px"></td><td><input name="scale_min_${i}" type="number" value="${c?.scale_min ?? 1}" style="width:64px"></td><td><input name="scale_max_${i}" type="number" value="${c?.scale_max ?? 5}" style="width:64px"></td><td class="muted">${c ? `${Math.round((100 * c.weight) / wsum)}%` : ''}</td></tr>`)}
</tbody></table></div><input type="hidden" name="rows" value="${rows.length}"><p><button>Save rubric</button></p></form></div>
<aside><h2>Tracks</h2><div class="card">${trk.length ? h`<ul>${trk.map((t) => h`<li>${t.name} <form class="inline" method="post" action="/e/${e.slug}/manage/track/${t.id}/delete">${csrfField(ctx.actor)}<button class="link small">remove</button></form></li>`)}</ul>` : h`<p class="muted">No tracks.</p>`}
<form class="row" method="post" action="/e/${e.slug}/manage/track">${csrfField(ctx.actor)}<input name="name" placeholder="New track" required aria-label="Track name"><button class="small shrink">Add</button></form></div>
<h2>Prizes</h2><div class="card">${prz.length ? h`<ul>${prz.map((p) => h`<li>${p.name}${p.track_id ? h` <span class="muted small">(${trk.find((t) => t.id === p.track_id)?.name})</span>` : ''} <form class="inline" method="post" action="/e/${e.slug}/manage/prize/${p.id}/delete">${csrfField(ctx.actor)}<button class="link small">remove</button></form></li>`)}</ul>` : h`<p class="muted">No prizes.</p>`}
<form class="stack" method="post" action="/e/${e.slug}/manage/prize">${csrfField(ctx.actor)}<input name="name" placeholder="Prize name" required aria-label="Prize name"><select name="track_id" aria-label="Prize track"><option value="">Overall</option>${trk.map((t) => h`<option value="${t.id}">${t.name}</option>`)}</select><button class="small">Add prize</button></form></div>
<h2>Export</h2><div class="card"><ul><li><a href="/api/events/${e.id}/export/scores.csv">Scores CSV</a> (one row per review)</li><li><a href="/api/events/${e.id}/export/results.csv">Results CSV</a></li><li><a href="/api/events/${e.id}/export/projects.csv">Projects CSV</a></li><li><a href="/api/events/${e.id}/export/bundle.json">Full event bundle (JSON)</a></li></ul></div></aside></div>`);
  });
  r.on('POST', '/e/:event/manage/setup', async (req, ctx) => {
    const e = load(req, ctx);
    const u = updateEvent(ctx.db, ctx.clock, ctx.actor, e.id, await req.body());
    notify(e.id, 'event');
    return back(`/e/${u.slug}/manage/setup`, 'Settings saved.');
  });
  r.on('POST', '/e/:event/manage/rubric', async (req, ctx) => {
    const e = load(req, ctx);
    const b = await req.body();
    const n = Math.min(Number(b.rows) || 0, 20);
    const rows: Array<Record<string, unknown>> = [];
    for (let i = 0; i < n; i++) {
      if (!String(b[`name_${i}`] ?? '').trim()) continue;
      rows.push({ name: b[`name_${i}`], key: b[`key_${i}`], description: b[`description_${i}`], weight: b[`weight_${i}`], scale_min: b[`scale_min_${i}`], scale_max: b[`scale_max_${i}`] });
    }
    saveCriteria(ctx.db, ctx.clock, ctx.actor, e.id, rows);
    return back(`/e/${e.slug}/manage/setup`, 'Rubric saved.');
  });
  r.on('POST', '/e/:event/manage/track', async (req, ctx) => {
    const e = load(req, ctx);
    addTrack(ctx.db, ctx.clock, ctx.actor, e.id, await req.body());
    return back(`/e/${e.slug}/manage/setup`, 'Track added.');
  });
  r.on('POST', '/e/:event/manage/prize', async (req, ctx) => {
    const e = load(req, ctx);
    addPrize(ctx.db, ctx.clock, ctx.actor, e.id, await req.body());
    return back(`/e/${e.slug}/manage/setup`, 'Prize added.');
  });
  r.on('POST', '/e/:event/manage/:kind/:id/delete', (req, ctx) => {
    const e = load(req, ctx);
    const kind = req.params.kind === 'track' ? 'track' : req.params.kind === 'prize' ? 'prize' : null;
    if (!kind) throw badRequest('Unknown kind.');
    deleteTrackOrPrize(ctx.db, ctx.clock, ctx.actor, e.id, kind, req.params.id!);
    return back(`/e/${e.slug}/manage/setup`, `${kind === 'track' ? 'Track' : 'Prize'} removed.`);
  });

  // ---- judges & assignments ----
  r.on('GET', '/e/:event/manage/judges', (req, ctx) => {
    const e = load(req, ctx);
    const js = judges(ctx.db, e.id);
    const trk = tracks(ctx.db, e.id);
    const trackName = new Map(trk.map((t) => [t.id, t.name]));
    const projects = eventProjects(ctx.db, e.id, false).filter((p) => !p.duplicate_of);
    const asg = all<{ judge_id: string; project_id: string; scored: number }>(ctx.db, 'SELECT a.judge_id, a.project_id, (s.id IS NOT NULL) scored FROM assignments a LEFT JOIN scores s ON s.judge_id = a.judge_id AND s.project_id = a.project_id WHERE a.event_id = ?', e.id);
    const conflicts = all<{ judge_id: string; project_id: string; reason: string }>(ctx.db, 'SELECT judge_id, project_id, reason FROM conflicts WHERE event_id = ?', e.id);
    const link = req.query.get('claim');
    return shell(req, ctx, e, 'judges', h`${link ? h`<div class="flash ok">Send this one-time setup link to the judge: <code class="pill mono">${link}</code> (prefix with this server's address).</div>` : ''}
<div class="cols"><div><h2>Judges (${js.length})</h2>${js.length ? h`<div class="table-wrap"><table><thead><tr><th>Judge</th><th>Tracks</th><th class="right">Assigned</th><th class="right">Scored</th><th></th></tr></thead><tbody>
${js.map((j) => h`<tr><td>${j.name}<div class="small muted">${j.email}${j.claimed ? '' : ' · has not set a password'}</div></td><td class="small">${j.tracks ? j.tracks.split(',').map((t) => trackName.get(t) ?? t).join(', ') : h`<span class="muted">any</span>`}</td><td class="right">${j.assigned}</td><td class="right">${j.scored}</td>
<td><form method="post" action="/e/${e.slug}/manage/judges/${j.id}/remove" onsubmit="return confirm('Remove this judge and their unscored assignments?')">${csrfField(ctx.actor)}<button class="link small">remove</button></form></td></tr>`)}</tbody></table></div>` : empty('No judges yet.')}
<h2>Assignments</h2><div class="card"><form method="post" action="/e/${e.slug}/manage/assign/auto" class="row">${csrfField(ctx.actor)}<label>Max per judge <span class="hint">optional</span><input type="number" name="max_per_judge" min="1"></label>
<button class="shrink">Auto-assign to ${e.reviews_per_project} reviews per project</button></form>
<p class="small muted">Balances load, prefers judges on the project's track, never assigns a declared conflict, and is deterministic. Existing assignments are kept.</p></div>
<div class="table-wrap"><table><thead><tr><th>Project</th><th>Track</th><th>Judges</th><th>Add</th></tr></thead><tbody>
${projects.map((p) => { const list = asg.filter((a) => a.project_id === p.id); return h`<tr><td><a href="/projects/${p.id}">${p.title}</a></td><td class="small">${p.track_name ?? ''}</td>
<td class="small">${list.length < e.reviews_per_project ? h`<span class="badge flag">${list.length}/${e.reviews_per_project}</span> ` : ''}${list.map((a) => h`<span class="badge ${a.scored ? 'ok' : ''}">${js.find((j) => j.id === a.judge_id)?.name ?? a.judge_id}${a.scored ? '' : h` <form class="inline" method="post" action="/e/${e.slug}/manage/unassign">${csrfField(ctx.actor)}<input type="hidden" name="judge_id" value="${a.judge_id}"><input type="hidden" name="project_id" value="${p.id}"><button class="link small" title="Unassign">×</button></form>`}</span> `)}</td>
<td><form class="row" method="post" action="/e/${e.slug}/manage/assign" style="flex-wrap:nowrap">${csrfField(ctx.actor)}<input type="hidden" name="project_id" value="${p.id}"><select name="judge_id" aria-label="Judge">${js.filter((j) => !list.some((a) => a.judge_id === j.id)).map((j) => h`<option value="${j.id}">${j.name}</option>`)}</select><button class="small shrink">+</button></form></td></tr>`; })}
</tbody></table></div>
${conflicts.length ? h`<h2>Declared conflicts</h2><ul>${conflicts.map((c) => h`<li>${js.find((j) => j.id === c.judge_id)?.name ?? c.judge_id} — ${projects.find((p) => p.id === c.project_id)?.title ?? c.project_id}: <span class="muted">${c.reason}</span></li>`)}</ul>` : ''}
</div><aside><h2>Invite a judge</h2><form class="stack card" method="post" action="/e/${e.slug}/manage/judges">${csrfField(ctx.actor)}
<label>Email<input type="email" name="email" required></label><label>Name<input name="name" maxlength="120"></label>
${trk.length ? h`<fieldset style="border:0;padding:0"><legend class="small"><b>Tracks</b> <span class="muted">(none = any)</span></legend>${trk.map((t) => h`<label style="display:flex;gap:6px;font-weight:400"><input type="checkbox" name="tracks" value="${t.id}" style="width:auto"> ${t.name}</label>`)}</fieldset>` : ''}
<button>Invite</button><p class="small muted">New accounts get a one-time link to set a password. Participants of this event cannot be judges.</p></form></aside></div>`);
  });
  r.on('POST', '/e/:event/manage/judges', async (req, ctx) => {
    const e = load(req, ctx);
    const res = inviteJudge(ctx.db, ctx.clock, ctx.actor, e.id, await req.body());
    const path = `/e/${e.slug}/manage/judges`;
    return back(res.claimLink ? `${path}?claim=${encodeURIComponent(res.claimLink)}` : path, `${res.judge.email} is now a judge.`);
  });
  r.on('POST', '/e/:event/manage/judges/:judge/remove', (req, ctx) => {
    const e = load(req, ctx);
    removeJudge(ctx.db, ctx.clock, ctx.actor, e.id, req.params.judge!);
    notify(e.id, 'assign');
    return back(`/e/${e.slug}/manage/judges`, 'Judge removed.');
  });
  r.on('POST', '/e/:event/manage/assign/auto', async (req, ctx) => {
    const e = load(req, ctx);
    const b = await req.body();
    const res = autoAssign(ctx.db, ctx.clock, ctx.actor, e.id, { maxPerJudge: b.max_per_judge ? Number(b.max_per_judge) : undefined });
    notify(e.id, 'assign');
    return back(`/e/${e.slug}/manage/judges`, `${res.created} assignments created${res.offTrack ? `, ${res.offTrack} outside the judge's tracks` : ''}${res.shortfall.length ? `; ${res.shortfall.length} projects still short of reviewers — invite more judges` : ''}.`);
  });
  r.on('POST', '/e/:event/manage/assign', async (req, ctx) => {
    const e = load(req, ctx);
    const b = await req.body();
    assign(ctx.db, ctx.clock, ctx.actor, e.id, String(b.judge_id ?? ''), String(b.project_id ?? ''));
    notify(e.id, 'assign');
    return back(`/e/${e.slug}/manage/judges`, 'Assigned.');
  });
  r.on('POST', '/e/:event/manage/unassign', async (req, ctx) => {
    const e = load(req, ctx);
    const b = await req.body();
    unassign(ctx.db, ctx.clock, ctx.actor, e.id, String(b.judge_id ?? ''), String(b.project_id ?? ''));
    notify(e.id, 'assign');
    return back(`/e/${e.slug}/manage/judges`, 'Unassigned.');
  });

  // ---- projects ----
  r.on('GET', '/e/:event/manage/projects', (req, ctx) => {
    const e = load(req, ctx);
    const ps = eventProjects(ctx.db, e.id, true);
    const teams = listTeams(ctx.db, e.id);
    const ext = all<{ team_id: string; until: string; reason: string }>(ctx.db, 'SELECT team_id, until, reason FROM deadline_extensions WHERE event_id = ?', e.id);
    const dups = ps.filter((p) => p.duplicate_of);
    return shell(req, ctx, e, 'projects', h`${dups.length ? h`<h2>Duplicates to review (${dups.length})</h2><div class="card"><p class="small muted">A team may have one canonical entry. Duplicates are excluded from judging and results. The importer picks the latest submission; pick another if that's wrong.</p>
<ul>${dups.map((d) => { const c = ps.find((p) => p.id === d.duplicate_of); return h`<li><b>${d.title}</b> (${d.id}, ${fmtDate(d.submitted_at)}) duplicates <b>${c?.title}</b> (${c?.id}, ${fmtDate(c?.submitted_at)}) — ${d.team_name}
<form class="inline" method="post" action="/e/${e.slug}/manage/projects/${d.id}/canonical">${csrfField(ctx.actor)}<button class="small secondary">Keep ${d.id} instead</button></form></li>`; })}</ul></div>` : ''}
<h2>All entries (${ps.length})</h2><div class="table-wrap"><table><thead><tr><th>Project</th><th>Team</th><th>Track</th><th>Status</th><th>Submitted</th></tr></thead><tbody>
${ps.map((p) => h`<tr><td><a href="/projects/${p.id}">${p.title}</a> <span class="mono muted small">${p.id}</span></td><td>${p.team_name}</td><td>${p.track_name ?? ''}</td><td><span class="badge ${p.duplicate_of ? 'flag' : p.status === 'submitted' ? 'ok' : 'draft'}">${p.duplicate_of ? 'duplicate' : p.status}</span></td><td class="small">${fmtDate(p.submitted_at)}</td></tr>`)}</tbody></table></div>
<div class="cols"><div><h2>Teams (${teams.length})</h2><div class="table-wrap"><table><thead><tr><th>Team</th><th class="right">Size</th><th>Entry</th></tr></thead><tbody>${teams.map((t) => h`<tr><td>${t.name}</td><td class="right">${t.size}</td><td>${t.project_id ? h`<a href="/projects/${t.project_id}">view</a>` : h`<span class="muted">none</span>`}</td></tr>`)}</tbody></table></div></div>
<aside><h2>Deadline extension</h2><form class="stack card" method="post" action="/e/${e.slug}/manage/extension">${csrfField(ctx.actor)}<label>Team<select name="team_id">${teams.map((t) => h`<option value="${t.id}">${t.name}</option>`)}</select></label>
<label>New deadline (UTC)<input type="datetime-local" name="until" required value="${toLocalInput(e.submissions_close_at)}"></label><label>Reason<input name="reason" required maxlength="300"></label><button>Grant</button>
<p class="small muted">Recorded in the audit log. Teams see their own deadline.</p></form>
${ext.length ? h`<ul class="small">${ext.map((x) => h`<li>${teams.find((t) => t.id === x.team_id)?.name}: ${fmtDate(x.until)} — ${x.reason}</li>`)}</ul>` : ''}</aside></div>`);
  });
  r.on('POST', '/e/:event/manage/projects/:project/canonical', (req, ctx) => {
    const e = load(req, ctx);
    resolveDuplicate(ctx.db, ctx.clock, ctx.actor, req.params.project!);
    notify(e.id, 'project');
    return back(`/e/${e.slug}/manage/projects`, 'Canonical entry updated.');
  });
  r.on('POST', '/e/:event/manage/extension', async (req, ctx) => {
    const e = load(req, ctx);
    grantExtension(ctx.db, ctx.clock, ctx.actor, e.id, await req.body());
    return back(`/e/${e.slug}/manage/projects`, 'Extension granted.');
  });

  // ---- results ----
  r.on('GET', '/e/:event/manage/results', (req, ctx) => {
    const e = load(req, ctx);
    const c = organizerResults(ctx.db, ctx.actor, e.id);
    const pub = currentPublication(ctx.db, e.id);
    const o = c.outcome;
    const moved = c.ranking.filter((p) => p.reviews && p.rank !== p.raw_rank).length;
    const flagText: Record<string, string> = { flat: 'flat: every score the same', single_review: 'only one review', lenient: 'lenient', harsh: 'harsh', compressed: 'uses a narrow range' };
    return shell(req, ctx, e, 'results', h`<div class="card row" style="align-items:center">
<div>${pub ? h`<b>Published</b> ${fmtDate(pub.published_at)} · hash <code class="pill mono">${pub.payload_hash.slice(0, 16)}…</code> · <a href="/e/${e.slug}/results">public page</a>` : h`<b>Not published.</b> <span class="muted">This preview is visible to organizers only. Publishing freezes a hashed snapshot and locks scoring.</span>`}</div>
<div class="shrink">${pub ? h`<form method="post" action="/e/${e.slug}/manage/retract" class="row">${csrfField(ctx.actor)}<input name="reason" placeholder="Reason for retracting" required aria-label="Reason"><button class="danger small shrink">Retract</button></form>`
      : h`<form method="post" action="/e/${e.slug}/manage/publish" onsubmit="return confirm('Publish results? Scoring will lock.')">${csrfField(ctx.actor)}<button>Publish results</button></form>`}</div></div>
<p class="muted">Method <code class="pill">${o.method}</code>${o.method === 'zscore_shrunk' ? h`, k = ${o.k}` : ''}. Pool mean ${o.globalMean.toFixed(1)}, spread ${o.globalSd.toFixed(1)} (0–100 scale). Calibration changes the position of <b>${moved}</b> of ${c.ranking.filter((p) => p.reviews).length} reviewed projects. <a href="/judging">Method</a> · <a href="/api/events/${e.id}/export/scores.csv">Scores CSV</a> · <a href="/api/events/${e.id}/export/results.csv">Results CSV</a></p>
<h2>Ranking: calibrated vs raw</h2><div class="table-wrap"><table><thead><tr><th>#</th><th>Raw #</th><th>Δ</th><th>Project</th><th>Track</th><th class="right">Reviews</th><th class="right">Calibrated</th><th class="right">Raw</th></tr></thead><tbody>
${c.ranking.map((p) => { const d = p.raw_rank - p.rank; return h`<tr><td><b>${p.reviews ? p.rank : '—'}</b></td><td>${p.reviews ? p.raw_rank : '—'}</td><td class="${d > 0 ? 'up' : d < 0 ? 'down' : 'muted'}">${p.reviews ? (d > 0 ? `▲${d}` : d < 0 ? `▼${-d}` : '·') : ''}</td>
<td><a href="/projects/${p.project_id}">${p.title}</a> <span class="small muted">${p.team}</span></td><td class="small">${p.track ?? ''}</td><td class="right">${p.reviews < e.reviews_per_project ? h`<span class="badge flag">${p.reviews}</span>` : p.reviews}</td>
<td class="right"><b>${p.reviews ? p.adjusted.toFixed(1) : '—'}</b> <span class="small muted">±${p.stderr.toFixed(1)}</span></td><td class="right">${p.reviews ? p.raw.toFixed(1) : '—'}</td></tr>`; })}</tbody></table></div>
<h2>Judge calibration</h2><p class="small muted">Offset: how far a judge's (shrunk) average sits from the pool, in points. Spread: their scale use relative to the pool (1.0 = typical). These are removed from each of their reviews.</p>
<div class="table-wrap"><table><thead><tr><th>Judge</th><th class="right">Reviews</th><th class="right">Raw mean</th><th class="right">Raw sd</th><th class="right">Offset</th><th class="right">Spread</th><th>Flags</th></tr></thead><tbody>
${o.judges.map((j) => h`<tr><td>${c.judgeNames[j.judgeId] ?? j.judgeId}</td><td class="right">${j.n}</td><td class="right">${j.rawMean.toFixed(1)}</td><td class="right">${j.rawSd.toFixed(1)}</td><td class="right ${j.offset > 0 ? 'up' : j.offset < 0 ? 'down' : ''}">${j.offset > 0 ? '+' : ''}${j.offset.toFixed(1)}</td><td class="right">${j.spread.toFixed(2)}</td><td>${j.flags.map((f) => h`<span class="badge flag">${flagText[f] ?? f}</span> `)}</td></tr>`)}</tbody></table></div>`);
  });
  r.on('POST', '/e/:event/manage/publish', (req, ctx) => {
    const e = load(req, ctx);
    publish(ctx.db, ctx.clock, ctx.actor, e.id);
    notify(e.id, 'publish');
    return back(`/e/${e.slug}/manage/results`, 'Results published.');
  });
  r.on('POST', '/e/:event/manage/retract', async (req, ctx) => {
    const e = load(req, ctx);
    const b = await req.body();
    retract(ctx.db, ctx.clock, ctx.actor, e.id, String(b.reason ?? ''));
    notify(e.id, 'publish');
    return back(`/e/${e.slug}/manage/results`, 'Results retracted.');
  });

  r.on('GET', '/e/:event/manage/audit', (req, ctx) => {
    const e = load(req, ctx);
    const chain = verifyAuditChain(ctx.db);
    const entries = eventAudit(ctx.db, e.id, 1000);
    return shell(req, ctx, e, 'audit', h`<div class="card">${chain.ok ? h`<span class="badge ok">Chain intact</span>` : h`<span class="badge flag">Chain broken at #${chain.brokenAt}</span>`} ${chain.entries} entries across the instance · head <code class="pill mono">${chain.head.slice(0, 16)}…</code>
<p class="small muted">Each entry stores the SHA-256 of the previous one; the database refuses updates and deletes on this table. <a href="/api/events/${e.id}/audit">JSON</a></p></div>
<div class="table-wrap"><table><thead><tr><th>#</th><th>When (UTC)</th><th>Who</th><th>Action</th><th>Subject</th><th>Detail</th></tr></thead><tbody>
${entries.map((a) => h`<tr><td class="mono small">${a.seq}</td><td class="small">${fmtDate(a.at)}</td><td class="small">${a.actor_label}</td><td><code class="pill">${a.action}</code></td><td class="mono small">${a.subject_id}</td><td class="mono small" style="max-width:420px;word-break:break-word">${a.detail.length > 300 ? a.detail.slice(0, 300) + '…' : a.detail}</td></tr>`)}</tbody></table></div>`);
  });

  // ---- admin ----
  r.on('GET', '/admin', (req, ctx) => {
    if (!ctx.actor.user) return needLogin(req);
    if (!isAdmin(ctx.actor)) throw forbidden('Admins only.');
    const users = all<{ id: string; email: string; name: string; platform_role: string; created_at: string; has_pw: number }>(ctx.db, 'SELECT id, email, name, platform_role, created_at, (password_hash IS NOT NULL) has_pw FROM users ORDER BY created_at DESC LIMIT 500');
    const chain = verifyAuditChain(ctx.db);
    return view(req, ctx, { title: 'Admin', wide: true }, h`<h1>Admin</h1><div class="card">${chain.ok ? h`<span class="badge ok">Audit chain intact</span>` : h`<span class="badge flag">Audit chain broken at #${chain.brokenAt}</span>`} ${chain.entries} entries</div>
<h2>Users</h2><div class="table-wrap"><table><thead><tr><th>User</th><th>Role</th><th>Password</th><th>Change role</th></tr></thead><tbody>
${users.map((u) => h`<tr><td>${u.name}<div class="small muted">${u.email}</div></td><td>${u.platform_role}</td><td>${u.has_pw ? 'set' : h`<span class="muted">not set</span>`}</td>
<td><form class="row" method="post" action="/admin/users/${u.id}/role" style="flex-wrap:nowrap">${csrfField(ctx.actor)}<select name="role" aria-label="Role">${['user', 'organizer', 'admin'].map((r) => h`<option ${r === u.platform_role ? 'selected' : ''}>${r}</option>`)}</select><button class="small shrink secondary">Set</button></form></td></tr>`)}</tbody></table></div>`);
  });
  r.on('POST', '/admin/users/:id/role', async (req, ctx) => {
    if (!isAdmin(ctx.actor)) throw forbidden('Admins only.');
    const b = await req.body();
    const role = String(b.role);
    if (!['user', 'organizer', 'admin'].includes(role)) throw badRequest('Unknown role.');
    if (req.params.id === ctx.actor.user!.id && role !== 'admin') throw badRequest('You cannot demote yourself.');
    run(ctx.db, 'UPDATE users SET platform_role = ? WHERE id = ?', role, req.params.id!);
    audit(ctx.db, { actor: ctx.actor, eventId: null, action: 'user.role', subjectType: 'user', subjectId: req.params.id!, detail: { role }, at: ctx.clock.now().toISOString() });
    return back('/admin', 'Role updated.');
  });
}

function progressView(p: ReturnType<typeof progress>): Html {
  return h`<div class="stats"><div class="stat"><span class="muted small">Submitted</span><b>${p.projects.submitted}</b></div><div class="stat"><span class="muted small">Drafts</span><b>${p.projects.drafts}</b></div>
<div class="stat"><span class="muted small">Duplicates</span><b>${p.projects.duplicates}</b></div><div class="stat"><span class="muted small">Reviews done</span><b>${p.scored}/${p.assignments}</b></div>
<div class="stat"><span class="muted small">Completion</span><b>${p.percent}%</b><div class="bar-meter"><i style="width:${p.percent}%"></i></div></div></div>
<div class="cols"><div><h2>Needs reviews (${p.under_reviewed.length})</h2>${p.under_reviewed.length ? h`<div class="table-wrap"><table><thead><tr><th>Project</th><th class="right">Scored</th><th class="right">Assigned</th></tr></thead><tbody>
${p.under_reviewed.slice(0, 40).map((u) => h`<tr><td><a href="/projects/${u.project_id}">${u.title}</a></td><td class="right">${u.scored}/${p.target_reviews_per_project}</td><td class="right ${u.assigned < p.target_reviews_per_project ? 'down' : ''}">${u.assigned}</td></tr>`)}</tbody></table></div>` : empty(`Every project has ${p.target_reviews_per_project} reviews.`)}</div>
<aside><h2>Judges</h2><div class="table-wrap"><table><thead><tr><th>Judge</th><th class="right">Done</th><th>Last score</th></tr></thead><tbody>
${p.judges.map((j) => h`<tr><td>${j.name}</td><td class="right ${j.scored < j.assigned ? 'down' : 'up'}">${j.scored}/${j.assigned}</td><td class="small muted">${fmtDate(j.last_activity)}</td></tr>`)}</tbody></table></div></aside></div>`;
}
