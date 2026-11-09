import { NormalizedEvent } from '../schema/types';

/**
 * Reads the daily files Snagboat writes (events/YYYY-MM-DD.jsonl) from text,
 * in the browser: one JSON object per line, as EventLog.readDay reads them,
 * but tolerant, since the files are whatever the person picked. Lines that
 * don't parse, or parse to something that isn't an event, are skipped and
 * counted; an event seen twice (two copies of a day, a source re-read)
 * counts once, as readDay does.
 */

export interface ParsedJsonl {
  events: NormalizedEvent[];
  /** Lines that weren't JSON, or weren't events. */
  skipped: number;
  /** Events whose id was already seen (not in `events`). */
  duplicates: number;
}

/** An object with the five strings every event has. Other fields are taken as they come. */
export function isNormalizedEvent(value: unknown): value is NormalizedEvent {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const o = value as Record<string, unknown>;
  return ['eventId', 'sessionId', 'agent', 'kind', 'ts'].every((k) => typeof o[k] === 'string' && (o[k] as string).length > 0);
}

/**
 * Parses one file's text. `seen` carries event ids across files, so a session
 * spanning two days (or a file dropped twice) is read once.
 */
export function parseJsonl(text: string, seen: Set<string> = new Set()): ParsedJsonl {
  const out: ParsedJsonl = { events: [], skipped: 0, duplicates: 0 };
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      out.skipped += 1;
      continue;
    }
    if (!isNormalizedEvent(parsed)) {
      out.skipped += 1;
      continue;
    }
    if (seen.has(parsed.eventId)) {
      out.duplicates += 1;
      continue;
    }
    seen.add(parsed.eventId);
    out.events.push(parsed);
  }
  return out;
}
