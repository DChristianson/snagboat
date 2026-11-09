import { NormalizedEvent } from './types';

/**
 * The UTC day an event belongs to, from its own timestamp: events are filed
 * under the day they happened, not the day they were written, so catching up
 * on an old transcript doesn't pile history into today's file. Falls back to
 * today for a missing or unparseable timestamp. Kept apart from EventLog
 * (which touches disk) so the session index, and the web demo's bundle, can
 * use it without fs.
 */
export function eventDay(event: NormalizedEvent): string {
  const ms = Date.parse(event.ts);
  return new Date(Number.isNaN(ms) ? Date.now() : ms).toISOString().slice(0, 10);
}
