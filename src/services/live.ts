import { EventEmitter } from 'node:events';

/** In-process fan-out for the live organizer dashboard (Server-Sent Events). */
export const live = new EventEmitter();
live.setMaxListeners(1000);

export function notify(eventId: string, kind: string): void {
  live.emit(`event:${eventId}`, kind);
}
