import { scryptSync, randomBytes, timingSafeEqual } from 'node:crypto';
import { type Db, get, run } from '../db/index.ts';
import { newId, randomToken, sha256, badRequest, conflict, iso, str, type Clock } from '../util.ts';

export type PlatformRole = 'user' | 'organizer' | 'admin';

export interface User {
  id: string;
  email: string;
  name: string;
  platform_role: PlatformRole;
}

export interface Actor {
  user: User | null;
  via: 'anonymous' | 'browser' | 'api';
  csrf: string | null;
}

export const ANONYMOUS: Actor = { user: null, via: 'anonymous', csrf: null };
export const SESSION_COOKIE = 'gbx_session';
const SESSION_DAYS = 14;

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 32, { N: 16384, r: 8, p: 1 });
  return `scrypt$16384$8$1$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export function verifyPassword(password: string, stored: string | null): boolean {
  if (!stored) return false;
  const [algo, n, r, p, salt, hash] = stored.split('$');
  if (algo !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64');
  const actual = scryptSync(password, Buffer.from(salt, 'base64'), expected.length, { N: Number(n), r: Number(r), p: Number(p) });
  return timingSafeEqual(actual, expected);
}

export function normalizeEmail(email: string): string {
  const e = email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) || e.length > 254) throw badRequest('A valid email is required.', 'validation');
  return e;
}

export function findUserByEmail(db: Db, email: string): (User & { password_hash: string | null }) | undefined {
  return get(db, 'SELECT id, email, name, platform_role, password_hash FROM users WHERE email = ?', email.trim().toLowerCase());
}

export function getUser(db: Db, id: string): User | undefined {
  return get<User>(db, 'SELECT id, email, name, platform_role FROM users WHERE id = ?', id);
}

export function createUser(
  db: Db,
  clock: Clock,
  input: { email: string; name: string; password?: string | null; role?: PlatformRole; id?: string },
): User {
  const email = normalizeEmail(input.email);
  if (findUserByEmail(db, email)) throw conflict('An account with that email already exists.', 'email_taken');
  if (input.password != null && input.password.length < 8) throw badRequest('Password must be at least 8 characters.', 'validation');
  const user: User = { id: input.id ?? newId('usr'), email, name: input.name.trim().slice(0, 120) || email, platform_role: input.role ?? 'user' };
  run(
    db,
    'INSERT INTO users (id, email, name, password_hash, platform_role, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    user.id, user.email, user.name, input.password ? hashPassword(input.password) : null, user.platform_role, iso(clock.now()),
  );
  return user;
}

/** Finds a user by email or creates a password-less placeholder (claimable via a one-time link). */
export function ensureUser(db: Db, clock: Clock, email: string, name?: string): { user: User; created: boolean } {
  const existing = findUserByEmail(db, normalizeEmail(email));
  if (existing) return { user: existing, created: false };
  return { user: createUser(db, clock, { email, name: name ?? email.split('@')[0] ?? email }), created: true };
}

export function createSession(db: Db, clock: Clock, userId: string, kind: 'browser' | 'api', label = '', fixedToken?: string): string {
  const token = fixedToken ?? randomToken(kind === 'api' ? 'gbx' : 'gbs');
  const now = clock.now();
  const expires = kind === 'browser' ? iso(new Date(now.getTime() + SESSION_DAYS * 86400_000)) : null;
  run(
    db,
    'INSERT OR REPLACE INTO sessions (token_hash, user_id, kind, label, csrf_token, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    sha256(token), userId, kind, label, randomToken('csrf', 18), iso(now), expires,
  );
  return token;
}

export function destroySession(db: Db, token: string): void {
  run(db, 'DELETE FROM sessions WHERE token_hash = ?', sha256(token));
}

export function resolveActor(db: Db, clock: Clock, headers: { authorization?: string }, cookies: Record<string, string>): Actor {
  const bearer = /^Bearer\s+(\S+)$/i.exec(headers.authorization ?? '')?.[1];
  const token = bearer ?? cookies[SESSION_COOKIE];
  if (!token) return ANONYMOUS;
  const row = get<User & { kind: 'browser' | 'api'; csrf_token: string; expires_at: string | null }>(
    db,
    `SELECT u.id, u.email, u.name, u.platform_role, s.kind, s.csrf_token, s.expires_at
       FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?`,
    sha256(token),
  );
  if (!row || (row.expires_at && row.expires_at < iso(clock.now()))) return ANONYMOUS;
  const user: User = { id: row.id, email: row.email, name: row.name, platform_role: row.platform_role };
  // Bearer tokens are not sent automatically by browsers, so they need no CSRF token.
  return bearer ? { user, via: 'api', csrf: null } : { user, via: 'browser', csrf: row.csrf_token };
}

export function login(db: Db, clock: Clock, email: string, password: string): { user: User; token: string } | null {
  const row = findUserByEmail(db, email);
  if (!row || !verifyPassword(password, row.password_hash)) return null;
  return { user: row, token: createSession(db, clock, row.id, 'browser', 'login') };
}

export function createClaimLink(db: Db, clock: Clock, userId: string, createdBy: string | null): string {
  const token = randomToken('claim', 18);
  run(db, 'INSERT INTO account_claims (token_hash, user_id, created_by, created_at) VALUES (?, ?, ?, ?)', sha256(token), userId, createdBy, iso(clock.now()));
  return token;
}

export function claimAccount(db: Db, clock: Clock, token: string, input: Record<string, unknown>): User {
  const row = get<{ user_id: string; used_at: string | null }>(db, 'SELECT user_id, used_at FROM account_claims WHERE token_hash = ?', sha256(token));
  if (!row || row.used_at) throw badRequest('This invite link is invalid or was already used.', 'invalid_claim');
  const password = str(input, 'password', { max: 200 });
  if (password.length < 8) throw badRequest('Password must be at least 8 characters.', 'validation');
  const name = str(input, 'name', { optional: true, max: 120 });
  run(db, 'UPDATE users SET password_hash = ?, name = COALESCE(NULLIF(?, \'\'), name) WHERE id = ?', hashPassword(password), name, row.user_id);
  run(db, 'UPDATE account_claims SET used_at = ? WHERE token_hash = ?', iso(clock.now()), sha256(token));
  const user = getUser(db, row.user_id);
  if (!user) throw badRequest('Account no longer exists.');
  return user;
}

export function claimInfo(db: Db, token: string): User | undefined {
  const row = get<{ user_id: string; used_at: string | null }>(db, 'SELECT user_id, used_at FROM account_claims WHERE token_hash = ?', sha256(token));
  return row && !row.used_at ? getUser(db, row.user_id) : undefined;
}
