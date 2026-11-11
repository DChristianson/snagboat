import { NormalizedEvent } from '@snagboat/schema';
import { isNormalizedEvent } from './jsonl';

/**
 * The web demo's example traces: hosts/web/demo/traces.js (made by npm run
 * demo:traces, Snagboat's src/scripts/demoTraces.ts) sets window.snagboatDemoTraces when
 * the page was built with it. Read defensively, like a loaded file: the
 * result is null without well-formed events, and keeps only picked ids the
 * events contain.
 */
export function readDemoTraces(value: unknown): { picked: string[]; events: NormalizedEvent[] } | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as { picked?: unknown; events?: unknown };
  const events = Array.isArray(v.events) ? v.events.filter(isNormalizedEvent) : [];
  if (!events.length) return null;
  const ids = new Set(events.map((e) => e.sessionId));
  const picked = Array.isArray(v.picked) ? v.picked.filter((id): id is string => typeof id === 'string' && ids.has(id)) : [];
  return { picked: picked.length ? picked : [...ids], events };
}
