import type { IncomingMessage, ServerResponse } from 'node:http';
import { HttpError } from '../util.ts';

export type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface Req {
  raw: IncomingMessage;
  res: ServerResponse;
  method: string;
  path: string;
  query: URLSearchParams;
  params: Record<string, string>;
  headers: IncomingMessage['headers'];
  cookies: Record<string, string>;
  ip: string;
  body(): Promise<Record<string, unknown>>;
}

export interface Reply {
  status: number;
  headers?: Record<string, string>;
  body?: string | Buffer;
  /** Streaming responses (SSE) manage `res` themselves. */
  streaming?: boolean;
}

export type Handler<C> = (req: Req, ctx: C) => Promise<Reply> | Reply;

interface Route<C> {
  method: Method;
  pattern: RegExp;
  keys: string[];
  handler: Handler<C>;
}

const MAX_BODY = 1_000_000;

export class Router<C> {
  private routes: Route<C>[] = [];

  on(method: Method, path: string, handler: Handler<C>): this {
    const keys: string[] = [];
    const pattern = new RegExp(
      '^' +
        path.replace(/\/:([a-zA-Z_]+)/g, (_m, k: string) => {
          keys.push(k);
          return '/([^/]+)';
        }) +
        '/?$',
    );
    this.routes.push({ method, pattern, keys, handler });
    return this;
  }

  match(method: string, path: string): { handler: Handler<C>; params: Record<string, string> } | 'method' | null {
    let pathMatched = false;
    for (const r of this.routes) {
      const m = r.pattern.exec(path);
      if (!m) continue;
      pathMatched = true;
      if (r.method !== method && !(method === 'HEAD' && r.method === 'GET')) continue;
      const params: Record<string, string> = {};
      r.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1] ?? '')));
      return { handler: r.handler, params };
    }
    return pathMatched ? 'method' : null;
  }
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (k) out[k] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function buildReq(raw: IncomingMessage, res: ServerResponse, params: Record<string, string>, url: URL): Req {
  let cached: Promise<Record<string, unknown>> | null = null;
  return {
    raw,
    res,
    method: raw.method ?? 'GET',
    path: url.pathname,
    query: url.searchParams,
    params,
    headers: raw.headers,
    cookies: parseCookies(raw.headers.cookie),
    ip: raw.socket.remoteAddress ?? 'unknown',
    body: () => (cached ??= readBody(raw)),
  };
}

async function readBody(raw: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of raw) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new HttpError(413, 'payload_too_large', 'Request body too large.');
    chunks.push(chunk as Buffer);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text) return {};
  const type = raw.headers['content-type'] ?? '';
  if (type.includes('application/json')) {
    try {
      const parsed: unknown = JSON.parse(text);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
      return { items: parsed };
    } catch {
      throw new HttpError(400, 'bad_json', 'Body is not valid JSON.');
    }
  }
  const form: Record<string, unknown> = {};
  for (const [k, v] of new URLSearchParams(text)) {
    if (k in form) {
      const prev = form[k];
      form[k] = Array.isArray(prev) ? [...prev, v] : [prev, v];
    } else form[k] = v;
  }
  return form;
}

export const json = (status: number, data: unknown, headers: Record<string, string> = {}): Reply => ({
  status,
  headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
  body: JSON.stringify(data, null, 2),
});

export const htmlReply = (status: number, body: string, headers: Record<string, string> = {}): Reply => ({
  status,
  headers: { 'content-type': 'text/html; charset=utf-8', ...headers },
  body,
});

export const redirect = (location: string, headers: Record<string, string> = {}): Reply => ({
  status: 303,
  headers: { location, ...headers },
});

export const csvReply = (filename: string, body: string): Reply => ({
  status: 200,
  headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="${filename}"` },
  body,
});
