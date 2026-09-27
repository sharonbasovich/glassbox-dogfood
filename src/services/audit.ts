import { type Db, all, get, run } from '../db/index.ts';
import { sha256 } from '../util.ts';
import type { Actor } from './auth.ts';

export interface AuditEntry {
  seq: number;
  at: string;
  actor_id: string | null;
  actor_label: string;
  event_id: string | null;
  action: string;
  subject_type: string;
  subject_id: string;
  detail: string;
  prev_hash: string;
  hash: string;
}

const GENESIS = '0'.repeat(64);

function entryHash(prev: string, e: Omit<AuditEntry, 'seq' | 'hash' | 'prev_hash'>): string {
  return sha256(
    prev + '\n' + JSON.stringify([e.at, e.actor_id, e.actor_label, e.event_id, e.action, e.subject_type, e.subject_id, e.detail]),
  );
}

export interface AuditInput {
  actor: Actor | null;
  eventId: string | null;
  action: string;
  subjectType: string;
  subjectId: string;
  detail?: Record<string, unknown>;
  at: string;
}

/** Appends a hash-chained entry. Call inside the same transaction as the change it records. */
export function audit(db: Db, input: AuditInput): void {
  const prev = get<{ hash: string }>(db, 'SELECT hash FROM audit_log ORDER BY seq DESC LIMIT 1')?.hash ?? GENESIS;
  const e = {
    at: input.at,
    actor_id: input.actor?.user?.id ?? null,
    actor_label: input.actor?.user ? `${input.actor.user.name} <${input.actor.user.email}>` : 'system',
    event_id: input.eventId,
    action: input.action,
    subject_type: input.subjectType,
    subject_id: input.subjectId,
    detail: JSON.stringify(input.detail ?? {}),
  };
  run(
    db,
    `INSERT INTO audit_log (at, actor_id, actor_label, event_id, action, subject_type, subject_id, detail, prev_hash, hash)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    e.at, e.actor_id, e.actor_label, e.event_id, e.action, e.subject_type, e.subject_id, e.detail, prev, entryHash(prev, e),
  );
}

export function eventAudit(db: Db, eventId: string, limit = 500): AuditEntry[] {
  return all<AuditEntry>(db, 'SELECT * FROM audit_log WHERE event_id = ? ORDER BY seq DESC LIMIT ?', eventId, limit);
}

/** Recomputes the whole chain; returns the first broken sequence number, if any. */
export function verifyAuditChain(db: Db): { ok: boolean; entries: number; brokenAt: number | null; head: string } {
  let prev = GENESIS;
  let n = 0;
  for (const e of all<AuditEntry>(db, 'SELECT * FROM audit_log ORDER BY seq')) {
    n++;
    if (e.prev_hash !== prev || entryHash(prev, e) !== e.hash) return { ok: false, entries: n, brokenAt: e.seq, head: prev };
    prev = e.hash;
  }
  return { ok: true, entries: n, brokenAt: null, head: prev };
}
