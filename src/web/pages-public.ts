import { Router, redirect } from '../http/router.ts';
import type { Ctx } from './ctx.ts';
import { h, fmtDate, phaseBadge, csrfField, empty, type Html } from './html.ts';
import { view, back, needLogin } from './common.ts';
import { claimAccount, claimInfo, createSession, createUser, destroySession, findUserByEmail, SESSION_COOKIE, verifyPassword } from '../services/auth.ts';
import { eventRoles, isOrganizer, teamMembership } from '../services/authz.ts';
import { type EventRow, listEvents, loadEvent, phase, prizes, tracks, criteria } from '../services/events.ts';
import { gallery, loadProjectFor, effectiveClose, type GalleryItem } from '../services/projects.ts';
import { getTeam, joinByInvite, listTeams, members, teamByInvite } from '../services/teams.ts';
import { currentPublication, publicResults, teamFeedback } from '../services/results.ts';
import { badRequest, str, unauthorized } from '../util.ts';

function cookie(ctx: Ctx, token: string, maxAge: number): string {
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${ctx.secureCookies ? '; Secure' : ''}`;
}

const safeNext = (n: unknown) => (typeof n === 'string' && /^\/(?![/\\])[^\\\x00-\x1f\x7f]*$/.test(n) ? n : '/');

export function projectCard(p: GalleryItem, showEvent = true): Html {
  return h`<article class="card"><h3><a href="/projects/${p.id}">${p.title}</a></h3>
<div class="muted small">${p.team_name}${p.track_name ? h` · ${p.track_name}` : ''}${showEvent ? h` · <a href="/e/${p.event_slug}">${p.event_name}</a>` : ''}</div>
<p>${p.summary || h`<span class="muted">No summary.</span>`}</p>
<div class="small">${p.repo_url ? h`<a href="${p.repo_url}" rel="noopener nofollow">Repo</a>` : ''} ${p.demo_url ? h`· <a href="${p.demo_url}" rel="noopener nofollow">Demo</a>` : ''}</div></article>`;
}

export function eventStatus(ctx: Ctx, e: EventRow): Html {
  const u = ctx.actor.user;
  if (!u) return h`<p><a class="btn" href="/login?next=/e/${e.slug}">Sign in to take part</a></p>`;
  const roles = eventRoles(ctx.db, u.id, e.id);
  const links: Html[] = [];
  if (isOrganizer(ctx.db, ctx.actor, e.id)) links.push(h`<a class="btn" href="/e/${e.slug}/manage">Organizer dashboard</a>`);
  if (roles.has('judge')) links.push(h`<a class="btn" href="/e/${e.slug}/judge">Your judging queue</a>`);
  const m = teamMembership(ctx.db, u.id, e.id);
  if (m) links.push(h`<a class="btn secondary" href="/e/${e.slug}/team">Your team</a> <a class="btn secondary" href="/e/${e.slug}/submit">Your project</a>`);
  else if (!roles.has('judge') && !roles.has('organizer') && phase(e, ctx.clock.now()) === 'open') links.push(h`<a class="btn" href="/e/${e.slug}/team">Join or create a team</a>`);
  return links.length ? h`<p class="row" style="flex:0">${links}</p>` : h``;
}

export function publicRoutes(r: Router<Ctx>): void {
  r.on('GET', '/', (req, ctx) => {
    const events = listEvents(ctx.db, ctx.actor);
    const now = ctx.clock.now();
    const count = (id: string) => ctx.db.prepare("SELECT COUNT(*) n FROM projects WHERE event_id = ? AND status = 'submitted' AND duplicate_of IS NULL").get(id) as { n: number };
    return view(req, ctx, { title: 'Events' }, h`<section class="hero"><h1>Hackathon submissions and judging, in the open.</h1>
<p>Teams submit until the server-enforced deadline. Judges score only what they are assigned and never see each other's scores. Organizers see raw and calibrated rankings side by side, with every change in a tamper-evident audit log.</p>
<p><a class="btn" href="/projects">Browse the gallery</a></p></section>
<h2>Events</h2>${events.length ? h`<div class="grid">${events.map((e) => h`<article class="card"><div>${phaseBadge(phase(e, now))} ${e.visibility === 'draft' ? h`<span class="badge draft">Draft</span>` : ''}</div>
<h3><a href="/e/${e.slug}">${e.name}</a></h3><p class="muted">${e.tagline}</p>
<div class="small muted">Submissions close ${fmtDate(e.submissions_close_at)} · ${count(e.id).n} projects</div></article>`)}</div>` : empty('No events yet.')}`);
  });

  r.on('GET', '/projects', (req, ctx) => {
    const q = req.query;
    const res = gallery(ctx.db, { q: q.get('q') ?? undefined, event: q.get('event') || undefined, track: q.get('track') || undefined, sort: (q.get('sort') as 'title') || undefined, page: Number(q.get('page')) || 1 });
    const events = listEvents(ctx.db, ctx.actor).filter((e) => e.visibility === 'public');
    const sel = events.find((e) => e.id === q.get('event') || e.slug === q.get('event'));
    const trackOpts = sel ? tracks(ctx.db, sel.id) : [];
    const link = (page: number) => { const p = new URLSearchParams(q); p.set('page', String(page)); return `/projects?${p}`; };
    return view(req, ctx, { title: 'Gallery', wide: true }, h`<h1>Project gallery</h1>
<form class="filters" method="get" action="/projects" role="search">
<input type="search" name="q" value="${q.get('q') ?? ''}" placeholder="Search titles, summaries, teams" aria-label="Search">
<select name="event" aria-label="Event" onchange="this.form.track && (this.form.track.value='');this.form.submit()"><option value="">All events</option>${events.map((e) => h`<option value="${e.slug}" ${sel?.id === e.id ? 'selected' : ''}>${e.name}</option>`)}</select>
${sel ? h`<select name="track" aria-label="Track"><option value="">All tracks</option>${trackOpts.map((t) => h`<option value="${t.id}" ${q.get('track') === t.id ? 'selected' : ''}>${t.name}</option>`)}</select>` : ''}
<select name="sort" aria-label="Sort"><option value="title">A–Z</option><option value="recent" ${q.get('sort') === 'recent' ? 'selected' : ''}>Most recent</option><option value="event" ${q.get('sort') === 'event' ? 'selected' : ''}>By event</option></select>
<button>Search</button></form>
<p class="muted small">${res.total} project${res.total === 1 ? '' : 's'}${res.pages > 1 ? h` · page ${res.page} of ${res.pages}` : ''}</p>
${res.items.length ? h`<div class="grid">${res.items.map((p) => projectCard(p))}</div>` : empty('No projects match.')}
${res.pages > 1 ? h`<p class="row" style="flex:0">${res.page > 1 ? h`<a class="btn secondary" href="${link(res.page - 1)}">Previous</a>` : ''}${res.page < res.pages ? h`<a class="btn secondary" href="${link(res.page + 1)}">Next</a>` : ''}</p>` : ''}`);
  });

  r.on('GET', '/projects/:id', (req, ctx) => {
    const p = loadProjectFor(ctx.db, ctx.actor, req.params.id!);
    const e = loadEvent(ctx.db, ctx.actor, p.event_id);
    const team = getTeam(ctx.db, p.team_id)!;
    const track = p.track_id ? tracks(ctx.db, e.id).find((t) => t.id === p.track_id) : undefined;
    const own = teamMembership(ctx.db, ctx.actor.user?.id, e.id)?.team_id === p.team_id;
    const assigned = !!ctx.actor.user && !!ctx.db.prepare('SELECT 1 FROM assignments WHERE judge_id = ? AND project_id = ?').get(ctx.actor.user.id, p.id);
    const fb = own ? teamFeedback(ctx.db, e.id, p.id) : { comments: [] };
    return view(req, ctx, { title: p.title, crumbs: [['/projects', 'Gallery'], [`/e/${e.slug}`, e.name]] }, h`
<div class="cols"><div><h1>${p.title}</h1><p class="muted">${p.summary}</p>
${p.status === 'draft' ? h`<p><span class="badge draft">Draft — only your team and organizers can see this</span></p>` : ''}
${p.duplicate_of ? h`<p><span class="badge flag">Marked as a duplicate of <a href="/projects/${p.duplicate_of}">another entry</a></span></p>` : ''}
<div class="card" style="white-space:pre-wrap">${p.description || h`<span class="muted">No description.</span>`}</div>
${fb.comments.length ? h`<h2>Judge feedback</h2>${fb.comments.map((c) => h`<div class="card">${c}</div>`)}` : ''}
</div><aside><div class="card"><dl class="kv"><dt>Team</dt><dd>${team.name}</dd><dt>Members</dt><dd>${members(ctx.db, team.id).map((m) => m.name).join(', ')}</dd>
<dt>Track</dt><dd>${track?.name ?? '—'}</dd><dt>Submitted</dt><dd>${fmtDate(p.submitted_at)}</dd>
${p.repo_url ? h`<dt>Repo</dt><dd><a href="${p.repo_url}" rel="noopener nofollow">${p.repo_url}</a></dd>` : ''}${p.demo_url ? h`<dt>Demo</dt><dd><a href="${p.demo_url}" rel="noopener nofollow">${p.demo_url}</a></dd>` : ''}</dl>
${own ? h`<p><a class="btn" href="/e/${e.slug}/submit">Edit</a></p>` : ''}${assigned ? h`<p><a class="btn" href="/e/${e.slug}/judge/${p.id}">Score this project</a></p>` : ''}</div></aside></div>`);
  });

  r.on('GET', '/e/:event', (req, ctx) => {
    const e = loadEvent(ctx.db, ctx.actor, req.params.event!);
    const now = ctx.clock.now();
    const ph = phase(e, now);
    const trk = tracks(ctx.db, e.id);
    const prz = prizes(ctx.db, e.id);
    const rub = criteria(ctx.db, e.id);
    const teams = listTeams(ctx.db, e.id);
    const res = gallery(ctx.db, { event: e.id });
    const my = teamMembership(ctx.db, ctx.actor.user?.id, e.id);
    const ext = my ? effectiveClose(ctx.db, e, my.team_id) : null;
    const wsum = rub.reduce((s, c) => s + c.weight, 0) || 1;
    return view(req, ctx, { title: e.name, wide: true }, h`<div>${phaseBadge(ph)}</div><h1>${e.name}</h1><p class="muted">${e.tagline}</p>
${eventStatus(ctx, e)}
${currentPublication(ctx.db, e.id) ? h`<p><a class="btn" href="/e/${e.slug}/results">See the results</a></p>` : ''}
<div class="cols"><div>
${e.description ? h`<div class="card" style="white-space:pre-wrap">${e.description}</div>` : ''}
<h2>Submitted projects (${res.total})</h2>${res.items.length ? h`<div class="grid">${res.items.map((p) => projectCard(p, false))}</div>` : empty('Nothing submitted yet.')}
</div><aside>
<div class="card"><h3>Dates (UTC)</h3><dl class="kv"><dt>Opens</dt><dd>${fmtDate(e.submissions_open_at)}</dd><dt>Closes</dt><dd><b>${fmtDate(e.submissions_close_at)}</b></dd>
${ext && ext !== e.submissions_close_at ? h`<dt>Your team</dt><dd>extended to ${fmtDate(ext)}</dd>` : ''}<dt>Judging ends</dt><dd>${fmtDate(e.judging_close_at)}</dd></dl>
${ph === 'open' ? h`<p class="small muted" data-deadline="${e.submissions_close_at}">The server clock decides. Late submissions are refused.</p>` : ''}</div>
<div class="card"><h3>Tracks</h3>${trk.length ? h`<ul>${trk.map((t) => h`<li><a href="/projects?event=${e.slug}&track=${t.id}">${t.name}</a></li>`)}</ul>` : h`<p class="muted">Open track only.</p>`}</div>
${prz.length ? h`<div class="card"><h3>Prizes</h3><ul>${prz.map((p) => h`<li><b>${p.name}</b>${p.track_id ? h` <span class="muted small">(${trk.find((t) => t.id === p.track_id)?.name})</span>` : ''}${p.description ? h`<br><span class="small muted">${p.description}</span>` : ''}</li>`)}</ul></div>` : ''}
<div class="card"><h3>How projects are judged</h3><ul>${rub.map((c) => h`<li>${c.name} — ${Math.round((100 * c.weight) / wsum)}% <span class="muted small">(${c.scale_min}–${c.scale_max})</span></li>`)}</ul>
<p class="small muted">Scores are calibrated across judges (${e.normalization === 'none' ? 'no calibration' : 'shrunk z-score'}). <a href="/judging">How this works</a></p></div>
<div class="card"><h3>Teams</h3><p class="muted small">${teams.length} teams, max ${e.max_team_size} people each.</p></div>
</aside></div>`);
  });

  r.on('GET', '/e/:event/results', (req, ctx) => {
    const e = loadEvent(ctx.db, ctx.actor, req.params.event!);
    let res;
    try {
      res = publicResults(ctx.db, ctx.actor, e.id);
    } catch {
      return view(req, ctx, { title: `${e.name} results`, crumbs: [[`/e/${e.slug}`, e.name]] }, empty('Results have not been published yet.'), 200);
    }
    const byTrack = new Map<string, typeof res.ranking>();
    for (const p of res.ranking) if (p.track) byTrack.set(p.track, [...(byTrack.get(p.track) ?? []), p]);
    return view(req, ctx, { title: `${e.name} results`, crumbs: [[`/e/${e.slug}`, e.name]], wide: true }, h`<h1>${e.name} — results</h1>
<p class="muted small">Published ${fmtDate(res.published_at)} · method <code class="pill">${res.method}</code>${res.method === 'zscore_shrunk' ? h` (k = ${res.shrinkage_k})` : ''} · snapshot hash <code class="pill mono" title="${res.payload_hash}">${res.payload_hash.slice(0, 16)}…</code> · <a href="/judging">method</a></p>
<div class="table-wrap"><table><thead><tr><th>#</th><th>Project</th><th>Team</th><th>Track</th><th class="right">Reviews</th><th class="right">Calibrated</th><th class="right">Raw</th><th class="right">Raw rank</th></tr></thead><tbody>
${res.ranking.map((p) => h`<tr><td><b>${p.reviews ? p.rank : '—'}</b></td><td><a href="/projects/${p.project_id}">${p.title}</a></td><td>${p.team}</td><td>${p.track ?? ''}</td><td class="right">${p.reviews}</td><td class="right"><b>${p.reviews ? p.adjusted.toFixed(1) : '—'}</b> <span class="muted small">±${p.stderr.toFixed(1)}</span></td><td class="right">${p.reviews ? p.raw.toFixed(1) : '—'}</td><td class="right">${p.reviews ? p.raw_rank : '—'}</td></tr>`)}
</tbody></table></div>
${byTrack.size ? h`<h2>Track leaders</h2><div class="grid">${[...byTrack].map(([t, list]) => h`<div class="card"><h3>${t}</h3><ol>${list.slice(0, 3).map((p) => h`<li>${p.title} <span class="muted small">${p.adjusted.toFixed(1)}</span></li>`)}</ol></div>`)}</div>` : ''}`);
  });

  r.on('GET', '/login', (req, ctx) => view(req, ctx, { title: 'Sign in' }, h`<h1>Sign in</h1><form class="stack card" method="post" action="/login">
<input type="hidden" name="next" value="${safeNext(req.query.get('next'))}">
<label>Email<input type="email" name="email" required autocomplete="username" autofocus></label>
<label>Password<input type="password" name="password" required autocomplete="current-password"></label>
<button>Sign in</button><p class="small muted">No account? <a href="/signup">Create one</a>. Judges receive a one-time link from the organizer.</p></form>`));

  r.on('POST', '/login', async (req, ctx) => {
    const b = await req.body();
    const user = findUserByEmail(ctx.db, String(b.email ?? ''));
    if (!user || !verifyPassword(String(b.password ?? ''), user.password_hash)) throw unauthorized('Wrong email or password.');
    const token = createSession(ctx.db, ctx.clock, user.id, 'browser', 'login');
    return redirect(safeNext(b.next), { 'set-cookie': cookie(ctx, token, 14 * 86400) });
  });

  r.on('GET', '/signup', (req, ctx) => view(req, ctx, { title: 'Create account' }, h`<h1>Create an account</h1><form class="stack card" method="post" action="/signup">
<input type="hidden" name="next" value="${safeNext(req.query.get('next'))}">
<label>Name<input name="name" required maxlength="120" autocomplete="name"></label>
<label>Email<input type="email" name="email" required autocomplete="email"></label>
<label>Password <span class="hint">At least 8 characters.</span><input type="password" name="password" required minlength="8" autocomplete="new-password"></label>
<button>Create account</button></form>`));

  r.on('POST', '/signup', async (req, ctx) => {
    const b = await req.body();
    const password = String(b.password ?? '');
    if (password.length < 8) throw badRequest('Password must be at least 8 characters.', 'validation');
    const user = createUser(ctx.db, ctx.clock, { email: str(b, 'email', { max: 254 }), name: str(b, 'name', { max: 120 }), password });
    const token = createSession(ctx.db, ctx.clock, user.id, 'browser', 'signup');
    return redirect(safeNext(b.next), { 'set-cookie': cookie(ctx, token, 14 * 86400) });
  });

  r.on('POST', '/logout', (req, ctx) => {
    const t = req.cookies[SESSION_COOKIE];
    if (t) destroySession(ctx.db, t);
    return redirect('/', { 'set-cookie': cookie(ctx, '', 0) });
  });

  r.on('GET', '/claim/:token', (req, ctx) => {
    const u = claimInfo(ctx.db, req.params.token!);
    if (!u) return view(req, ctx, { title: 'Invite link' }, empty('This link is invalid or was already used.'), 404);
    return view(req, ctx, { title: 'Set up your account' }, h`<h1>Welcome, ${u.name}</h1><p class="muted">Set a password for <b>${u.email}</b> to continue.</p>
<form class="stack card" method="post" action="/claim/${req.params.token!}"><label>Name<input name="name" value="${u.name}" maxlength="120"></label>
<label>Password <span class="hint">At least 8 characters.</span><input type="password" name="password" required minlength="8" autocomplete="new-password"></label><button>Save and sign in</button></form>`);
  });

  r.on('POST', '/claim/:token', async (req, ctx) => {
    const user = claimAccount(ctx.db, ctx.clock, req.params.token!, await req.body());
    const token = createSession(ctx.db, ctx.clock, user.id, 'browser', 'claim');
    return redirect('/', { 'set-cookie': cookie(ctx, token, 14 * 86400) });
  });

  r.on('GET', '/join/:code', (req, ctx) => {
    const team = teamByInvite(ctx.db, req.params.code!);
    if (!team) return view(req, ctx, { title: 'Invite' }, empty('This invite link is invalid or has been rotated.'), 404);
    const e = loadEvent(ctx.db, ctx.actor, team.event_id);
    if (!ctx.actor.user) return needLogin(req);
    const m = members(ctx.db, team.id);
    return view(req, ctx, { title: `Join ${team.name}`, crumbs: [[`/e/${e.slug}`, e.name]] }, h`<h1>Join ${team.name}</h1>
<p class="muted">${e.name} · ${m.length}/${e.max_team_size} members: ${m.map((x) => x.name).join(', ')}</p>
<form method="post" action="/join/${team.invite_code}">${csrfField(ctx.actor)}<button>Join team</button></form>`);
  });

  r.on('POST', '/join/:code', (req, ctx) => {
    const t = joinByInvite(ctx.db, ctx.clock, ctx.actor, req.params.code!);
    const e = loadEvent(ctx.db, ctx.actor, t.event_id);
    return back(`/e/${e.slug}/team`, `You joined ${t.name}.`);
  });

  r.on('GET', '/judging', (req, ctx) => view(req, ctx, { title: 'How judging works' }, JUDGING_EXPLAINER));
}


const JUDGING_EXPLAINER = h`<h1>How judging works</h1>
<div class="card"><h3>1. Weighted rubric</h3><p>Each judge scores each assigned project on every criterion of the event's rubric. A review's raw total is the weighted mean of its criteria, each rescaled to 0–100. Weights are relative and shown on the event page.</p></div>
<div class="card"><h3>2. Why calibrate</h3><p>Judges differ. One gives everything a 4, another uses the whole scale, another is harsh. If a project happens to draw the lenient judge it wins on luck. Glassbox removes each judge's personal offset and spread before averaging.</p></div>
<div class="card"><h3>3. The method: shrunk z-scores</h3><p>For each judge we estimate their mean and spread, but <b>shrink</b> both toward the pool of all judges in proportion to how few reviews they gave (k pseudo-reviews, default 3). A judge with two reviews is barely adjusted; a judge with twenty is adjusted fully. A flat judge (all the same score) does not explode into infinite z-scores: their spread is shrunk toward the pool's.</p>
<p>Each review becomes <code class="pill">z = (raw − judge mean) / judge spread</code>, mapped back to points as <code class="pill">global mean + z × global spread</code>. A project's calibrated score is the mean over its reviews, with a standard error. Projects with no reviews are listed last, never ranked above reviewed ones.</p></div>
<div class="card"><h3>4. Transparent by default</h3><p>Organizers see raw and calibrated rankings side by side, the offset and spread applied to each judge, and flags for flat, lenient, harsh and single-review judges. Every score change is recorded in a hash-chained audit log. Published results are a frozen, hashed snapshot.</p></div>`;
