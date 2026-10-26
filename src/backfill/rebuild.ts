import * as fs from 'fs';
import * as path from 'path';
import { mainTranscriptOf, readTranscriptSession } from '../adapters/claude-code/transcriptSession';
import { CopilotCliState, copilotSessionNameEvent, normalizeCopilotCliChunk, readSessionName } from '../adapters/copilot/cliSessions';
import { EventLog, eventDay } from '../core/eventLog';
import { NormalizedEvent } from '../core/types';
import { dayStats, DayStats, mergeDay, promptedTurns, sourceFileOf } from './merge';

/**
 * The reading half of the backfill command: re-reads every session log the
 * chosen days' events came from, from the top, with fresh parser state. The
 * live tailers and their checkpoints are untouched.
 */

export interface Rebuilt {
  /** Rebuilt events for the target days only. */
  byDay: Map<string, NormalizedEvent[]>;
  /** Every file read, including subagent transcripts no stored event pointed at yet. */
  reread: Set<string>;
  /** Source files that are gone (Claude Code deletes old transcripts) or unreadable. */
  missing: string[];
}

/**
 * Re-reads the sources of the given days' events. Rebuilt events are kept for
 * targetDays (default: the given days), which should include the days of any
 * events filed under the wrong day.
 */
export async function rebuildDays(dayEvents: Map<string, NormalizedEvent[]>, opts: { captureContent: boolean }, targetDays?: Set<string>): Promise<Rebuilt> {
  const claudeSessions = new Set<string>();
  const copilotLogs = new Set<string>();
  for (const events of dayEvents.values()) {
    for (const e of events) {
      const file = sourceFileOf(e);
      if (!file) continue;
      if (e.raw.adapter === 'claude-code') claudeSessions.add(mainTranscriptOf(file));
      else copilotLogs.add(file);
    }
  }

  const reread = new Set<string>();
  const missing: string[] = [];
  const all: NormalizedEvent[] = [];
  for (const main of claudeSessions) {
    const result = await readTranscriptSession(main, opts);
    result.files.forEach((f) => reread.add(f));
    missing.push(...result.missing);
    all.push(...result.events);
  }
  for (const file of copilotLogs) {
    let lines: string[];
    try {
      lines = (await fs.promises.readFile(file, 'utf8')).split('\n').filter((l) => l.trim());
    } catch {
      missing.push(file);
      continue;
    }
    reread.add(file);
    const state = new CopilotCliState();
    all.push(...normalizeCopilotCliChunk(lines, file, 0, state, opts));
    const named = opts.captureContent ? readSessionName(file) : undefined;
    if (named) all.push(copilotSessionNameEvent(state.sessionId ?? path.basename(path.dirname(file)), named.name, file, named.updatedAt));
  }

  const byDay = new Map<string, NormalizedEvent[]>([...(targetDays ?? dayEvents.keys())].map((d) => [d, []]));
  for (const e of all) byDay.get(eventDay(e))?.push(e);
  return { byDay, reread, missing };
}

export interface BackfillPlan {
  startedAt: string;
  rebuilt: Rebuilt;
  /** Every day to rewrite, newest first: the chosen ones and those receiving misfiled events. */
  days: Array<{ day: string; events: NormalizedEvent[]; stats: DayStats; after: DayStats; chosen: boolean }>;
  /** A day's events after backfill, from its events at the time of writing. */
  merge: (day: string, current: NormalizedEvent[]) => NormalizedEvent[];
}

/**
 * Re-reads the chosen days' sources and works out every day's result, for the
 * dry run and then the write. Older builds filed events under the day they
 * were written, so a day's file can hold other days' events; their rebuilt
 * versions go to their own day, so those days are rewritten too (and may hold
 * misfiled events of their own). A misfiled event whose own day is past raw
 * retention has nowhere to go, so it stays put.
 */
export async function planBackfill(
  eventLog: EventLog,
  chosen: Map<string, NormalizedEvent[]>,
  opts: { captureContent: boolean; oldestRawDay: string }
): Promise<BackfillPlan> {
  const dayEvents = new Map(chosen);
  const pending = [...dayEvents.values()];
  while (pending.length) {
    for (const e of pending.pop()!) {
      const day = eventDay(e);
      if (!sourceFileOf(e) || dayEvents.has(day) || day < opts.oldestRawDay) continue;
      const events = await eventLog.readDay(day);
      dayEvents.set(day, events);
      pending.push(events);
    }
  }
  const keepOld = (e: NormalizedEvent) => eventDay(e) < opts.oldestRawDay;
  const startedAt = new Date().toISOString();
  const rebuilt = await rebuildDays(dayEvents, { captureContent: opts.captureContent });
  const merge = (day: string, current: NormalizedEvent[]) => mergeDay(current, rebuilt.byDay.get(day) ?? [], rebuilt.reread, startedAt, keepOld);
  const merged = new Map([...dayEvents].map(([day, events]) => [day, merge(day, events)]));
  // Links are counted across every day in the plan, since a turn can cross midnight.
  const promptsBefore = promptedTurns([...dayEvents.values()].flat());
  const promptsAfter = promptedTurns([...merged.values()].flat());
  const days = [...dayEvents]
    .sort(([a], [b]) => b.localeCompare(a))
    .map(([day, events]) => ({ day, events, stats: dayStats(events, promptsBefore), after: dayStats(merged.get(day)!, promptsAfter), chosen: chosen.has(day) }));
  return { startedAt, rebuilt, days, merge };
}
