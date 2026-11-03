/**
 * The presentation review as a dev script: replays history to the moments a
 * warning or several findings were active, rebuilds the status bar and
 * tooltip with their own code, and runs the fixed checks, so design problems
 * are found while building Snagboat, not only in a user's review. Dev tooling
 * only; never shipped.
 *
 *   npm run review:ui [-- [--fixture] [--days 7] [--models a,b [--base-url <url>] | --advisor a,b [--settings <path>]] [--all-projects | <session.jsonl> ...]]
 *
 * --fixture uses the redacted transcript in src/test/fixtures; otherwise this
 * project's transcripts. --models (or --advisor, from your VS Code settings,
 * with each advisor's own prompts; see evalAdvisor.ts) also asks each for the
 * advisor's two parts of the review (the week's summary, and how findings
 * were shown) over the same data, and writes the answers to out/eval/. The
 * console shows heuristic ids, severities, and checks only.
 */
import * as fs from 'fs';
import * as path from 'path';
import { FetchLike, complete } from '../advisor/providers';
import { proposeNudgesMessages } from '../advisor/proposeNudges';
import { advisorSection, summarizeWeekMessages } from '../advisor/summarizeWeek';
import { builtInHeuristics } from '../heuristics/builtIns';
import { buildReview } from '../review/review';
import { runsFromArgs } from './evalAdvisor';
import { defaultSessions, sessionEvents } from './replayHeuristics';

function arg(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const v = args[i + 1];
  args.splice(i, 2);
  return v;
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const days = Number(arg(args, '--days') ?? 7);
  const models = (arg(args, '--models') ?? '').split(',').map((m) => m.trim()).filter(Boolean);
  const advisorIds = (arg(args, '--advisor') ?? '').split(',').map((m) => m.trim()).filter(Boolean);
  const settingsFile = arg(args, '--settings');
  const baseUrl = (arg(args, '--base-url') ?? 'http://localhost:11434/v1').replace(/\/+$/, '');
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
  const events = all.filter((e) => e.ts >= from);
  const review = buildReview({ workspace: path.basename(process.cwd()), from, to, events, heuristics: builtInHeuristics(), settingsFor: () => ({}), savedRules: [], responses: [], muted: [] });

  const p = review.presentation;
  console.log(`${days} days to ${to.slice(0, 16)}: ${p.moments} moments with a warning or several findings active.\n`);
  for (const s of p.snapshots.slice(0, 10)) {
    console.log(`${s.moment.at.slice(0, 16)}  ${s.moment.active.map((a) => `${a.heuristicId}(${a.severity})`).join(', ')}`);
    console.log(`  status bar: ${s.statusBar}`);
    for (const line of s.tooltip) console.log(`  tooltip:    ${line}`);
  }
  console.log(p.checks.length ? '\nChecks:' : '\nChecks: nothing to fix.');
  for (const c of p.checks) console.log(`  ${c.id}: ${c.title} (${c.moments} of ${p.moments})\n    ${c.recommendation}`);

  if (models.length === 0 && advisorIds.length === 0) return 0;
  let runs;
  try {
    runs = runsFromArgs(models, baseUrl, advisorIds, settingsFile);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }
  const report = [`# Advisor evaluation: review`, '', `${new Date().toISOString()} · runs: ${runs.map((r) => r.label).join(', ')}`, ''];
  const parts = [
    { ability: 'summarize-week' as const, title: "The advisor's summary of the week", build: summarizeWeekMessages },
    { ability: 'propose-nudges' as const, title: 'The advisor on how findings were shown', build: proposeNudgesMessages },
  ];
  for (const run of runs) {
    report.push(`## ${run.label}`);
    for (const part of parts) {
      if (!run.policy(part.ability)) {
        console.log(`\n${run.label}, ${part.title}: doesn't offer ${part.ability}`);
        continue;
      }
      const started = Date.now();
      try {
        const c = await complete(run.provider, part.build(review, run.prompts(part.ability), run.policy(part.ability)), run.apiKey, fetch as unknown as FetchLike);
        console.log(`\n${run.label}, ${part.title}: ${((Date.now() - started) / 1000).toFixed(1)}s, read ${c.promptTokens ?? '?'} tokens`);
        report.push(advisorSection(`${part.title} (${((Date.now() - started) / 1000).toFixed(1)}s)`, c.text, run.label).replace(/^## /m, '### '));
      } catch (err) {
        console.log(`\n${run.label}, ${part.title}: error: ${err instanceof Error ? err.message : String(err)}`);
        report.push('', `### ${part.title}`, '', `Error: ${err instanceof Error ? err.message : String(err)}`, '');
      }
    }
  }
  const outDir = path.join(process.cwd(), 'out', 'eval');
  fs.mkdirSync(outDir, { recursive: true });
  const file = path.join(outDir, `review-${new Date().toISOString().replace(/[:.]/g, '-')}.md`);
  fs.writeFileSync(file, report.join('\n') + '\n');
  console.log(`\nReport: ${file}`);
  return 0;
}

if (require.main === module) main().then((code) => process.exit(code));
