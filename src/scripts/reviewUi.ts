/**
 * The presentation review as a dev script: replays history to the moments a
 * warning or several findings were active, rebuilds the status bar and
 * tooltip with their own code, and runs the fixed checks, so design problems
 * are found while building Snagboat. Dev tooling only; never shipped.
 *
 *   npm run review:ui [-- [--fixture] [--days 7] [--all-projects | <session.jsonl> ...]]
 *
 * --fixture uses the redacted transcript in src/test/fixtures; otherwise this
 * project's transcripts. The console shows heuristic ids, severities, and
 * checks only. (Until snagboat-79f.7.12 it could also ask models for the
 * weekly review's advisor sections; the weekly review is gone.)
 */
import * as path from 'path';
import { NormalizedEvent } from '@snagboat/schema';
import { builtInHeuristics } from '../heuristics/builtIns';
import { FindingReplay, ReplayEpisode } from '../heuristics/replay';
import { momentsFrom, presentationChecks, snapshotAt } from '../review/presentation';
import { defaultSessions, sessionEvents } from './replayHeuristics';

function arg(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const v = args[i + 1];
  args.splice(i, 2);
  return v;
}

/** Each session replayed through the built-in heuristics, as the live engine would have run them. */
function replayEpisodes(events: NormalizedEvent[]): ReplayEpisode[] {
  const bySession = new Map<string, NormalizedEvent[]>();
  for (const e of events) bySession.set(e.sessionId, [...(bySession.get(e.sessionId) ?? []), e]);
  const episodes: ReplayEpisode[] = [];
  for (const list of bySession.values()) {
    const replay = new FindingReplay(builtInHeuristics(), () => ({}));
    for (const e of list) replay.ingest(e);
    episodes.push(...replay.episodes());
  }
  return episodes;
}

function main(): number {
  const args = process.argv.slice(2);
  const days = Number(arg(args, '--days') ?? 7);
  const fixtureAt = args.indexOf('--fixture');
  if (fixtureAt >= 0) args.splice(fixtureAt, 1);
  const allAt = args.indexOf('--all-projects');
  if (allAt >= 0) args.splice(allAt, 1);

  const files = fixtureAt >= 0 ? [path.join(process.cwd(), 'src', 'test', 'fixtures', 'claude-transcript-redacted.jsonl')] : args.length > 0 ? args : defaultSessions(allAt >= 0);
  const all = files.flatMap((f) => sessionEvents(f)).sort((a, b) => a.ts.localeCompare(b.ts));
  if (all.length === 0) {
    console.error('No events found.');
    return 1;
  }
  // The fixture is old, so the window ends at the history's last event rather than now.
  const to = all[all.length - 1].ts;
  const from = new Date(Date.parse(to) - days * 86_400_000).toISOString();
  const moments = momentsFrom(replayEpisodes(all.filter((e) => e.ts >= from)));
  const checks = presentationChecks(moments, new Map());

  console.log(`${days} days to ${to.slice(0, 16)}: ${moments.length} moments with a warning or several findings active.\n`);
  for (const s of moments.slice(0, 10).map(snapshotAt)) {
    console.log(`${s.moment.at.slice(0, 16)}  ${s.moment.active.map((a) => `${a.heuristicId}(${a.severity})`).join(', ')}`);
    console.log(`  status bar: ${s.statusBar}`);
    for (const line of s.tooltip) console.log(`  tooltip:    ${line}`);
  }
  console.log(checks.length ? '\nChecks:' : '\nChecks: nothing to fix.');
  for (const c of checks) console.log(`  ${c.id}: ${c.title} (${c.moments} of ${moments.length})\n    ${c.recommendation}`);
  return 0;
}

if (require.main === module) process.exit(main());
