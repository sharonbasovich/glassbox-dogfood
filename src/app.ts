import type { IncomingMessage, ServerResponse } from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, normalize, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Router, buildReq, htmlReply, json, redirect, type Reply } from './http/router.ts';
import type { Db } from './db/index.ts';
import { HttpError, type Clock } from './util.ts';
import { resolveActor } from './services/auth.ts';
import type { Ctx } from './web/ctx.ts';
import { apiRoutes } from './web/api.ts';
import { publicRoutes } from './web/pages-public.ts';
import { teamRoutes } from './web/pages-team.ts';
import { organizerRoutes } from './web/pages-organizer.ts';
import { page, h } from './web/html.ts';

const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');
const TYPES: Record<string, string> = { '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.js': 'text/javascript; charset=utf-8', '.png': 'image/png', '.txt': 'text/plain; charset=utf-8' };

const SECURITY_HEADERS: Record<string, string> = {
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'same-origin',
  'content-security-policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'; form-action 'self'; base-uri 'none'",
};

export interface AppOptions {
  db: Db;
  clock: Clock;
  secureCookies?: boolean;
}

const isApi = (path: string) => path.startsWith('/api/') || path === '/healthz';

export function createApp(opts: AppOptions): (req: IncomingMessage, res: ServerResponse) => void {
  const router = new Router<Ctx>();
  apiRoutes(router);
  publicRoutes(router);
  teamRoutes(router);
  organizerRoutes(router);

  const send = (res: ServerResponse, reply: Reply) => {
    if (reply.streaming) return;
    res.writeHead(reply.status, { ...SECURITY_HEADERS, ...(reply.headers ?? {}) });
    res.end(reply.body ?? '');
  };

  const serveStatic = (path: string, res: ServerResponse): boolean => {
    const rel = normalize(path.slice('/static/'.length)).replace(/^(\.\.[/\\])+/, '');
    const file = join(PUBLIC_DIR, rel);
    if (!file.startsWith(PUBLIC_DIR) || !existsSync(file) || !statSync(file).isFile()) return false;
    res.writeHead(200, { ...SECURITY_HEADERS, 'content-type': TYPES[extname(file)] ?? 'application/octet-stream', 'cache-control': 'public, max-age=3600' });
    res.end(readFileSync(file));
    return true;
  };

  return (raw, res) => {
    const url = new URL(raw.url ?? '/', 'http://localhost');
    const method = raw.method ?? 'GET';
    const handle = async (): Promise<Reply> => {
      if (url.pathname.startsWith('/static/') && (method === 'GET' || method === 'HEAD')) {
        if (serveStatic(url.pathname, res)) return { status: 200, streaming: true };
      }
      const m = router.match(method, url.pathname);
      if (m === null) throw new HttpError(404, 'not_found', 'Page not found.');
      if (m === 'method') throw new HttpError(405, 'method_not_allowed', `${method} is not allowed here.`);
      const req = buildReq(raw, res, m.params, url);
      const actor = resolveActor(opts.db, opts.clock, { authorization: raw.headers.authorization }, req.cookies);
      // CSRF: cookie-authenticated writes must carry the session's token. Bearer (API) requests are exempt.
      if (method !== 'GET' && method !== 'HEAD' && actor.via === 'browser') {
        const b = await req.body();
        const sent = (raw.headers['x-csrf-token'] as string | undefined) ?? (typeof b._csrf === 'string' ? b._csrf : '');
        if (sent !== actor.csrf) throw new HttpError(403, 'csrf', 'Your form expired. Reload the page and try again.');
      }
      return m.handler(req, { db: opts.db, clock: opts.clock, actor, secureCookies: !!opts.secureCookies });
    };

    handle()
      .then((reply) => send(res, reply))
      .catch((err: unknown) => {
        const e = err instanceof HttpError ? err : new HttpError(500, 'internal', 'Something went wrong.');
        if (!(err instanceof HttpError)) console.error(err);
        if (res.headersSent) return res.end();
        if (isApi(url.pathname)) return send(res, json(e.status, { error: { code: e.code, message: e.message } }));
        if (method === 'POST' && e.status < 500) {
          const ref = raw.headers.referer;
          let path = url.pathname;
          try {
            if (ref) {
              const r = new URL(ref);
              if (r.host === raw.headers.host) path = r.pathname + r.search;
            }
          } catch { /* keep default */ }
          if (e.status === 401 && path !== '/login') return send(res, redirect(`/login?next=${encodeURIComponent(path)}&err=${encodeURIComponent(e.message)}`));
          const clean = path.replace(/([?&])(ok|err)=[^&]*/g, '$1').replace(/[?&]+$/, '').replace(/\?&/, '?');
          return send(res, redirect(`${clean}${clean.includes('?') ? '&' : '?'}err=${encodeURIComponent(e.message)}`));
        }
        if (e.status === 401 && method === 'GET') return send(res, redirect(`/login?next=${encodeURIComponent(url.pathname + url.search)}`));
        const actor = (() => {
          try {
            const cookies = Object.fromEntries((raw.headers.cookie ?? '').split(';').map((c) => c.trim().split('=')).filter((kv) => kv.length === 2).map(([k, v]) => [k!, decodeURIComponent(v!)]));
            return resolveActor(opts.db, opts.clock, { authorization: raw.headers.authorization }, cookies);
          } catch {
            return { user: null, via: 'anonymous' as const, csrf: null };
          }
        })();
        return send(res, htmlReply(e.status, page({ actor, title: e.status === 404 ? 'Not found' : 'Error' }, h`<div class="empty"><h1>${e.status === 404 ? 'Not found' : e.status === 403 ? 'Not allowed' : 'Error'}</h1><p>${e.message}</p><p><a href="/">Home</a></p></div>`)));
      });
  };
}
