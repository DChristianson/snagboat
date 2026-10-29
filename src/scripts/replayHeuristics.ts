/**
 * Replays local Claude Code transcripts through every built-in heuristic and
 * reports, per session, what would have fired and when. For calibrating
 * thresholds against real history. Dev tooling only; never shipped.
 *
 *   npm run replay:heuristics [-- [--settings '<json>'] [--rules <rules.json>] [--all-projects | <session.jsonl> ...]]
 *
 * --rules adds rules (a JSON list, as in snagboat.rules) to the replay, so a
 * hand-written rule can be scored against real history before you add it.
 *
 * Defaults to this project's transcripts under ~/.claude/projects (with their
 * subagent transcripts); --all-projects replays every project's. --settings overrides heuristic settings by id, e.g.
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
import { normalizeTranscriptSession, sessionFiles } from '../adapters/claude-code/transcriptSession';
import { NormalizedEvent } from '../core/types';
import { FindingReplay } from '../heuristics/replay';
import { builtInHeuristics } from '../heuristics/builtIns';
import { buildRuleSet } from '../heuristics/rule';
import { ruleHeuristic } from '../heuristics/ruleHeuristic';
import { Heuristic } from '../heuristics/types';

export function sessionEvents(mainFile: string): NormalizedEvent[] {
  const files = sessionFiles(mainFile, (dir) => fs.readdirSync(dir)).map((file) => ({ file, lines: fs.readFileSync(file, 'utf8').split('\n') }));
  return normalizeTranscriptSession(files, { captureContent: true });
}

export interface Episode {
  heuristic: string;
  severity: string;
  startMin: number;
  endMin: number;
}

/** Replays events in time order with 30-second ticks between them, as the extension would. */
export function replay(events: NormalizedEvent[], settings: Record<string, Record<string, unknown>>, extra: Heuristic[] = []): Episode[] {
  // Context limits as the extension learns them: reported per call, or an auto-compaction's size.
  const limits = new Map<string, number>();
  const learnLimit = (e: NormalizedEvent) => {
    const limit = e.contextLimit ?? (e.kind === 'compaction' && e.compaction?.trigger === 'auto' ? e.compaction.preTokens : undefined);
    if (e.model && limit && limit < (limits.get(e.model) ?? Infinity)) limits.set(e.model, limit);
  };
  const replayer = new FindingReplay([...builtInHeuristics(), ...extra], (id) => settings[id] ?? {}, (model) => (model ? limits.get(model) : undefined));
  for (const event of events) {
    learnLimit(event);
    replayer.ingest(event);
  }
  const start = Date.parse(events[0].ts);
  const minutes = (ts: string) => Math.round(((Date.parse(ts) - start) / 60_000) * 10) / 10;
  return replayer.episodes().map((e) => ({ heuristic: e.heuristicId, severity: e.severity, startMin: minutes(e.startTs), endMin: minutes(e.endTs) }));
}

function sessionsIn(dir: string): string[] {
  try {
    return fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')).map((f) => path.join(dir, f));
  } catch {
    return [];
  }
}

export function defaultSessions(allProjects: boolean): string[] {
  const root = path.join(os.homedir(), '.claude', 'projects');
  if (!allProjects) return sessionsIn(path.join(root, process.cwd().replace(/[^a-zA-Z0-9]/g, '-')));
  try {
    return fs.readdirSync(root).flatMap((d) => sessionsIn(path.join(root, d)));
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
  let rules: Heuristic[] = [];
  const rulesAt = args.indexOf('--rules');
  if (rulesAt >= 0) {
    const set = buildRuleSet([{ origin: args[rulesAt + 1], rules: JSON.parse(fs.readFileSync(args[rulesAt + 1], 'utf8')), categories: [] }]);
    for (const problem of set.problems) console.error(problem);
    if (set.problems.length > 0) return 1;
    rules = set.rules.map(ruleHeuristic);
    args.splice(rulesAt, 2);
  }
  const allAt = args.indexOf('--all-projects');
  if (allAt >= 0) args.splice(allAt, 1);
  const sessions = args.length > 0 ? args : defaultSessions(allAt >= 0);
  if (sessions.length === 0) {
    console.error('No transcripts found. Pass session .jsonl paths explicitly.');
    return 1;
  }
  const ids = [...builtInHeuristics(), ...rules].map((h) => h.id);
  const width = Math.max(16, ...ids.map((id) => id.length));
  const totals = new Map<string, number>(ids.map((id) => [id, 0]));
  for (const file of sessions) {
    const events = sessionEvents(file);
    if (events.length === 0) continue;
    const durationMin = Math.round((Date.parse(events[events.length - 1].ts) - Date.parse(events[0].ts)) / 60_000);
    const count = (kind: string) => events.filter((e) => e.kind === kind).length;
    console.log(`\n${path.basename(file)}: ${durationMin} min, ${count('user_prompt')} prompts, ${count('turn_stop')} model calls, ${count('tool_call')} tool calls`);
    const episodes = replay(events, settings, rules);
    for (const id of ids) {
      const mine = episodes.filter((e) => e.heuristic === id);
      totals.set(id, (totals.get(id) ?? 0) + mine.length);
      const when = mine.slice(0, 6).map((e) => `${e.startMin}m${e.endMin > e.startMin ? `-${e.endMin}m` : ''}${e.severity === 'warn' ? '' : ' (info)'}`);
      console.log(`  ${id.padEnd(width)} ${String(mine.length).padStart(3)} episode(s)${when.length ? `  at ${when.join(', ')}${mine.length > 6 ? ', …' : ''}` : ''}`);
    }
  }
  console.log('\nTotal episodes: ' + ids.map((id) => `${id} ${totals.get(id)}`).join(', '));
  return 0;
}

if (require.main === module) process.exit(main());
