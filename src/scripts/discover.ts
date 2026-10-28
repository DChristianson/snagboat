/**
 * Runs discovery without a model over local Claude Code transcripts, as
 * **Snagboat: Discover Heuristics** does over a workspace's stored history,
 * and prints the report. Dev tooling only; never shipped.
 *
 *   npm run discover [-- [--settings '<json>'] [--all-projects | <session.jsonl> ...]]
 *
 * Defaults to this project's transcripts. The report names command families
 * and heuristic ids only: never targets, paths, prompts, or session names.
 */
import * as path from 'path';
import { discover } from '../discovery/discover';
import { formatDiscovery } from '../discovery/report';
import { builtInHeuristics } from '../heuristics/builtIns';
import { NormalizedEvent } from '../core/types';
import { defaultSessions, sessionEvents } from './replayHeuristics';

function main(): number {
  const args = process.argv.slice(2);
  let settings: Record<string, Record<string, unknown>> = {};
  const settingsAt = args.indexOf('--settings');
  if (settingsAt >= 0) {
    settings = JSON.parse(args[settingsAt + 1]);
    args.splice(settingsAt, 2);
  }
  const allAt = args.indexOf('--all-projects');
  if (allAt >= 0) args.splice(allAt, 1);
  const sessions = args.length > 0 ? args : defaultSessions(allAt >= 0);
  if (sessions.length === 0) {
    console.error('No transcripts found. Pass session .jsonl paths explicitly.');
    return 1;
  }
  const events: NormalizedEvent[] = sessions.flatMap((file) => sessionEvents(file));
  // Context limits as the extension learns them: reported per call, or an auto-compaction's size.
  const limits = new Map<string, number>();
  for (const e of events) {
    const limit = e.contextLimit ?? (e.kind === 'compaction' && e.compaction?.trigger === 'auto' ? e.compaction.preTokens : undefined);
    if (e.model && limit && limit < (limits.get(e.model) ?? Infinity)) limits.set(e.model, limit);
  }
  const started = Date.now();
  const result = discover(events, { existing: builtInHeuristics(), settingsFor: (id) => settings[id] ?? {}, contextLimit: (m) => (m ? limits.get(m) : undefined) });
  const source = allAt >= 0 ? 'all projects' : args.length > 0 ? `${sessions.length} transcripts` : path.basename(process.cwd());
  console.log(formatDiscovery(result, source).join('\n'));
  console.log(`\n(${((Date.now() - started) / 1000).toFixed(1)}s)`);
  return 0;
}

if (require.main === module) process.exit(main());
