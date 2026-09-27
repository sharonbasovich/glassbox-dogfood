import type { Actor } from '../services/auth.ts';
import type { Phase } from '../services/events.ts';

export class Html {
  readonly value: string;
  constructor(value: string) {
    this.value = value;
  }
  toString(): string {
    return this.value;
  }
}

export function esc(v: unknown): string {
  return String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

/** Tagged template that escapes every interpolation unless it is already Html (or an array of Html). */
export function h(strings: TemplateStringsArray, ...values: unknown[]): Html {
  let out = strings[0]!;
  values.forEach((v, i) => {
    out += render(v) + strings[i + 1]!;
  });
  return new Html(out);
}

function render(v: unknown): string {
  if (v instanceof Html) return v.value;
  if (Array.isArray(v)) return v.map(render).join('');
  if (v === null || v === undefined || v === false) return '';
  return esc(v);
}

export const raw = (s: string) => new Html(s);

export function fmtDate(isoStr: string | null | undefined): string {
  if (!isoStr) return '—';
  return isoStr.replace('T', ' ').replace(/:\d{2}(\.\d+)?Z$/, ' UTC');
}

export function toLocalInput(isoStr: string | null | undefined): string {
  return isoStr ? isoStr.slice(0, 16) : '';
}

const PHASE_LABEL: Record<Phase, string> = { upcoming: 'Upcoming', open: 'Submissions open', judging: 'Judging', closed: 'Judging closed', published: 'Results published' };
export const phaseBadge = (p: Phase) => h`<span class="badge phase-${p}">${PHASE_LABEL[p]}</span>`;

export function csrfField(actor: Actor): Html {
  return actor.csrf ? h`<input type="hidden" name="_csrf" value="${actor.csrf}">` : h``;
}

export interface PageOpts {
  actor: Actor;
  title: string;
  flash?: { ok?: string | null; err?: string | null };
  crumbs?: Array<[string, string]>;
  wide?: boolean;
}

export function page(opts: PageOpts, body: Html): string {
  const u = opts.actor.user;
  const flash = h`${opts.flash?.ok ? h`<div class="flash ok" role="status">${opts.flash.ok}</div>` : ''}${opts.flash?.err ? h`<div class="flash err" role="alert">${opts.flash.err}</div>` : ''}`;
  return `<!doctype html>` + h`<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${opts.title} · Glassbox</title><link rel="stylesheet" href="/static/app.css"><link rel="icon" href="/static/favicon.svg"></head>
<body><header class="top"><div class="wrap${opts.wide ? ' wide' : ''} bar">
<a class="brand" href="/"><img src="/static/favicon.svg" alt="" width="22" height="22"> Glassbox</a>
<nav><a href="/projects">Gallery</a><a href="/">Events</a>${u && (u.platform_role === 'organizer' || u.platform_role === 'admin') ? h`<a href="/events/new">New event</a>` : ''}${u?.platform_role === 'admin' ? h`<a href="/admin">Admin</a>` : ''}</nav>
<div class="who">${u ? h`<span title="${u.email}">${u.name}</span><form method="post" action="/logout">${csrfField(opts.actor)}<button class="link">Sign out</button></form>` : h`<a href="/login">Sign in</a><a class="btn small" href="/signup">Create account</a>`}</div>
</div></header>
<main class="wrap${opts.wide ? ' wide' : ''}">${opts.crumbs?.length ? h`<nav class="crumbs">${opts.crumbs.map(([href, label], i) => h`${i ? ' / ' : ''}<a href="${href}">${label}</a>`)}</nav>` : ''}${flash}${body}</main>
<footer class="wrap${opts.wide ? ' wide' : ''} foot">Glassbox — open-source, self-hosted hackathon judging. Every score change is in the audit log.</footer>
</body></html>`.value;
}

export function empty(msg: string, extra: Html | string = ''): Html {
  return h`<div class="empty"><p>${msg}</p>${extra instanceof Html ? extra : ''}</div>`;
}
