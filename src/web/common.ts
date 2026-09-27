import { redirect, htmlReply, type Req, type Reply } from '../http/router.ts';
import type { Ctx } from './ctx.ts';
import { page, type PageOpts, type Html } from './html.ts';

export function flashOf(req: Req): PageOpts['flash'] {
  return { ok: req.query.get('ok'), err: req.query.get('err') };
}

export function view(req: Req, ctx: Ctx, opts: Omit<PageOpts, 'actor' | 'flash'>, body: Html, status = 200): Reply {
  return htmlReply(status, page({ ...opts, actor: ctx.actor, flash: flashOf(req) }, body));
}

export function back(path: string, ok?: string): Reply {
  if (!ok) return redirect(path);
  return redirect(`${path}${path.includes('?') ? '&' : '?'}ok=${encodeURIComponent(ok)}`);
}

export function needLogin(req: Req): Reply {
  return redirect(`/login?next=${encodeURIComponent(req.path + (req.query.size ? `?${req.query}` : ''))}`);
}
