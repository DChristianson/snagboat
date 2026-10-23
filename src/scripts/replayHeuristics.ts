/**
 * Replays local Claude Code transcripts through every built-in heuristic and
 * reports, per session, what would have fired and when. For calibrating
 * thresholds against real history. Dev tooling only; never shipped.
 *
 *   npm run replay:heuristics [-- [--settings '<json>'] <session.jsonl> ...]
 *
 * Defaults to this project's transcripts under ~/.claude/projects (with their
 * subagent transcripts). --settings overrides heuristic settings by id, e.g.
 * '{"tool-churn":{"minCalls":5},"token-budget":{"session":20000000}}'.
 *
 * Prints counts and times only: never prompt or reply text, commands, file
 * paths, or finding summaries (which can contain paths). Reply text is read
 * in memory for verbal-hedge, as if snagboat.captureContent were on.
 *
 * Transcripts don't contain hook events, so tool calls are rebuilt from each
 * model call's tool_use blocks, with success or failure from the matching
 * tool_result. File saves (edit-tracker) aren't in transcripts and so aren't
 * replayed.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { normalizeTranscriptChunk, SeenMessages, TurnTracker } from '../adapters/claude-code/normalize';
import { classifyTool } from '../core/toolCategory';
import { EventStore } from '../core/eventStore';
import { NormalizedEvent } from '../core/types';
import { HeuristicsEngine } from '../heuristics/engine';
import { builtInHeuristics } from '../heuristics/builtIns';

const TICK_MS = 30_000; // the extension's poll interval

/** Tool calls rebuilt from tool_use blocks and their tool_results. */
function toolCallEvents(lines: any[], file: string, turns: TurnTracker): NormalizedEvent[] {
  const results = new Map<string, { failed: boolean; ts: string }>();
  for (const d of lines) {
    if (d?.type !== 'user' || !Array.isArray(d.message?.content)) continue;
    for (const b of d.message.content) {
      if (b?.type === 'tool_result' && b.tool_use_id) results.set(b.tool_use_id, { failed: b.is_error === true, ts: d.timestamp });
    }
  }
  const events: NormalizedEvent[] = [];
  for (const d of lines) {
    if (d?.type !== 'assistant' || !Array.isArray(d.message?.content)) continue;
    const turnId = turns.observe(file, d); // re-observing is idempotent
    for (const b of d.message.content) {
      if (b?.type !== 'tool_use') continue;
      const result = results.get(b.id);
      const input = b.input ?? {};
      events.push({
        eventId: `tool:${b.id}`,
        sessionId: d.sessionId ?? 'unknown-session',
        agent: 'claude-code',
        ts: result?.ts ?? d.timestamp,
        kind: 'tool_call',
        target: input.file_path ?? input.command,
        status: result ? (result.failed ? 'failure' : 'success') : 'unknown',
        toolName: b.name,
        toolCategory: classifyTool(b.name, input.command),
        turnId,
        agentId: d.agentId,
        raw: { adapter: 'replay', ref: 'n/a' },
      });
    }
  }
  return events;
}

export function sessionEvents(mainFile: string): NormalizedEvent[] {
  const files = [mainFile];
  const subDir = path.join(path.dirname(mainFile), path.basename(mainFile, '.jsonl'), 'subagents');
  if (fs.existsSync(subDir)) for (const f of fs.readdirSync(subDir)) if (f.endsWith('.jsonl')) files.push(path.join(subDir, f));
  const turns = new TurnTracker();
  const seen = new SeenMessages();
  const events: NormalizedEvent[] = [];
  for (const file of files) {
    const raw = fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim());
    events.push(...normalizeTranscriptChunk(raw, file, 0, { captureContent: true, seen, turns }));
    const parsed = raw.map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return undefined;
      }
    });
    events.push(...toolCallEvents(parsed, file, turns));
  }
  return events.filter((e) => !Number.isNaN(Date.parse(e.ts))).sort((a, b) => a.ts.localeCompare(b.ts));
}

export interface Episode {
  heuristic: string;
  severity: string;
  startMin: number;
  endMin: number;
}

/** Replays events in time order with 30-second ticks between them, as the extension would. */
export function replay(events: NormalizedEvent[], settings: Record<string, Record<string, unknown>>): Episode[] {
  const store = new EventStore({ windowMs: 24 * 60 * 60 * 1000, maxEvents: 100_000 });
  const engine = new HeuristicsEngine(builtInHeuristics(), store, (id) => settings[id] ?? {});
  const start = Date.parse(events[0].ts);
  const open = new Map<string, Episode>();
  const episodes: Episode[] = [];
  const minutes = (ms: number) => Math.round(((ms - start) / 60_000) * 10) / 10;
  const apply = (results: Map<string, Array<{ severity: string }>>, nowMs: number) => {
    for (const [id, findings] of results) {
      const current = open.get(id);
      if (findings.length > 0 && !current) {
        const severity = findings.some((f) => f.severity === 'warn') ? 'warn' : 'info';
        const ep = { heuristic: id, severity, startMin: minutes(nowMs), endMin: minutes(nowMs) };
        open.set(id, ep);
        episodes.push(ep);
      } else if (findings.length > 0 && current) {
        current.endMin = minutes(nowMs);
        if (findings.some((f) => f.severity === 'warn')) current.severity = 'warn';
      } else if (findings.length === 0 && current) {
        open.delete(id);
      }
    }
  };
  let lastTick = start;
  for (const event of events) {
    const t = Date.parse(event.ts);
    for (let tick = lastTick + TICK_MS; tick < t; tick += TICK_MS) {
      apply(engine.tick(new Date(tick).toISOString()), tick);
      lastTick = tick;
    }
    store.ingest(event);
    apply(engine.tickFor(event.kind, event.ts), t);
  }
  return episodes;
}

function defaultSessions(): string[] {
  const dir = path.join(os.homedir(), '.claude', 'projects', process.cwd().replace(/[^a-zA-Z0-9]/g, '-'));
  try {
    return fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')).map((f) => path.join(dir, f));
  } catch {
    return [];
  }
}

function main(): number {
  const args = process.argv.slice(2);
  let settings: Record<string, Record<string, unknown>> = {};
  const settingsAt = args.indexOf('--settings');
  if (settingsAt >= 0) {
    settings = JSON.parse(args[settingsAt + 1]);
    args.splice(settingsAt, 2);
  }
  const sessions = args.length > 0 ? args : defaultSessions();
  if (sessions.length === 0) {
    console.error('No transcripts found. Pass session .jsonl paths explicitly.');
    return 1;
  }
  const ids = builtInHeuristics().map((h) => h.id);
  const totals = new Map<string, number>(ids.map((id) => [id, 0]));
  for (const file of sessions) {
    const events = sessionEvents(file);
    if (events.length === 0) continue;
    const durationMin = Math.round((Date.parse(events[events.length - 1].ts) - Date.parse(events[0].ts)) / 60_000);
    const count = (kind: string) => events.filter((e) => e.kind === kind).length;
    console.log(`\n${path.basename(file)}: ${durationMin} min, ${count('user_prompt')} prompts, ${count('turn_stop')} model calls, ${count('tool_call')} tool calls`);
    const episodes = replay(events, settings);
    for (const id of ids) {
      const mine = episodes.filter((e) => e.heuristic === id);
      totals.set(id, (totals.get(id) ?? 0) + mine.length);
      const when = mine.slice(0, 6).map((e) => `${e.startMin}m${e.endMin > e.startMin ? `-${e.endMin}m` : ''}${e.severity === 'warn' ? '' : ' (info)'}`);
      console.log(`  ${id.padEnd(14)} ${String(mine.length).padStart(3)} episode(s)${when.length ? `  at ${when.join(', ')}${mine.length > 6 ? ', …' : ''}` : ''}`);
    }
  }
  console.log('\nTotal episodes: ' + ids.map((id) => `${id} ${totals.get(id)}`).join(', '));
  return 0;
}

if (require.main === module) process.exit(main());
