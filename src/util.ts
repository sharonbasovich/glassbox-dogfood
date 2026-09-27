import { randomBytes, createHash } from 'node:crypto';

export function newId(prefix: string): string {
  return `${prefix}_${randomBytes(9).toString('base64url')}`;
}

export function randomToken(prefix: string, bytes = 24): string {
  return `${prefix}_${randomBytes(bytes).toString('base64url')}`;
}

export function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

export function slugify(text: string): string {
  return text.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'event';
}

export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

export function iso(d: Date): string {
  return d.toISOString();
}

export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export const badRequest = (msg: string, code = 'bad_request') => new HttpError(400, code, msg);
export const unauthorized = (msg = 'Sign in required.') => new HttpError(401, 'unauthenticated', msg);
export const forbidden = (msg: string, code = 'forbidden') => new HttpError(403, code, msg);
export const notFound = (msg = 'Not found.') => new HttpError(404, 'not_found', msg);
export const conflict = (msg: string, code = 'conflict') => new HttpError(409, code, msg);

/** Reads a required, trimmed string field with a length cap. */
export function str(input: Record<string, unknown>, key: string, opts: { max?: number; optional?: boolean } = {}): string {
  const raw = input[key];
  const value = typeof raw === 'string' ? raw.trim() : raw == null ? '' : String(raw).trim();
  if (!value && !opts.optional) throw badRequest(`"${key}" is required.`, 'validation');
  if (value.length > (opts.max ?? 2000)) throw badRequest(`"${key}" is too long (max ${opts.max ?? 2000}).`, 'validation');
  return value;
}

export function isoField(input: Record<string, unknown>, key: string, optional = false): string | null {
  const v = str(input, key, { optional, max: 64 });
  if (!v) return null;
  const d = new Date(v.length === 16 ? `${v}:00Z` : v);
  if (Number.isNaN(d.getTime())) throw badRequest(`"${key}" must be an ISO-8601 date.`, 'validation');
  return d.toISOString();
}

export function urlField(input: Record<string, unknown>, key: string): string {
  const v = str(input, key, { optional: true, max: 500 });
  if (!v) return '';
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    throw badRequest(`"${key}" must be a URL.`, 'validation');
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw badRequest(`"${key}" must be http(s).`, 'validation');
  return u.toString();
}
