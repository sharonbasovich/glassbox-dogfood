import type { Db } from '../db/index.ts';
import type { Clock } from '../util.ts';
import type { Actor } from '../services/auth.ts';

export interface Ctx {
  db: Db;
  clock: Clock;
  actor: Actor;
  secureCookies: boolean;
}
