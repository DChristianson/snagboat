/**
 * Runs the advisor's Explain over digests of your own sessions with several
 * models, and writes their answers side by side, so default models are picked
 * from real use. Dev tooling only; never shipped.
 *
 *   npm run eval:advisor -- --models qwen3.5:latest,llama3.1:latest [--capability explain|propose] [--base-url <url>] [--sessions 2] [--all-projects | <session.jsonl> ...]
 *
 * --capability propose runs discovery over the sessions and asks each model
 * to name its candidates, propose rules, and group shell commands, through
 * the Suggestions tab's own controller, so what's kept or dropped is exactly
 * what the tab would show.
 *
 * --base-url defaults to Ollama on this machine. A provider off this machine
 * needs SNAGBOAT_EVAL_API_KEY and gets the hosted sending rules (no prompts or
 * session names), exactly as the extension would send.
 *
 * Each session gives up to three cases: Explain the session, its busiest turn,
 * and its first finding. Answers are checked automatically (the three
 * headings, no absolute paths, whether the server cut the prompt to fit its
 * context window); judging quality is yours, from the report. The console gets
 * counts and timings only. The report, with digests and answers, is written to
 * out/eval/, which isn't committed.
 */
import * as fs from 'fs';
import * as path from 'path';
import { buildDigest, digestForReading, DigestFinding, HOSTED_POLICY, LOCAL_POLICY, SessionDigest } from '../advisor/digest';
import { ExplainFocus, explainMessages } from '../advisor/explain';
import { complete, Completion, FetchLike, isLocalUrl, promptWasCut, ProviderConfig } from '../advisor/providers';
import { builtInHeuristics } from '../heuristics/builtIns';
import { FindingReplay } from '../heuristics/replay';
import { NormalizedEvent } from '../core/types';
import { defaultSessions, sessionEvents } from './replayHeuristics';
import * as os from 'os';
import { proposeMessages } from '../advisor/propose';
import { RuleStore } from '../heuristics/ruleStore';
import { SuggestionsController } from '../ui/suggestionsController';

interface Case {
  label: string;
  sessionId: string;
  digest: SessionDigest;
  focus: ExplainFocus;
}

interface Result {
  model: string;
  ms: number;
  completion?: Completion;
  error?: string;
  checks: { headings: boolean; noAbsolutePaths: boolean; truncated: boolean };
}

const HEADINGS = ['what happened', 'likely cause', 'what to try'];

function arg(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const v = args[i + 1];
  args.splice(i, 2);
  return v;
}

/** Up to three cases per session: the whole session, its busiest turn, and its first finding. */
function casesFor(events: NormalizedEvent[], policy: typeof LOCAL_POLICY, roots: string[]): Case[] {
  const sessionId = events[0].sessionId;
  const replay = new FindingReplay(builtInHeuristics(), () => ({}));
  for (const e of events) replay.ingest(e);
  const findings: DigestFinding[] = replay.episodes().map((e) => ({ heuristicId: e.heuristicId, severity: e.severity, summary: e.summary, startTs: e.startTs, endTs: e.endTs, eventRefs: e.eventRefs }));
  const input = { sessionId, events, findings, roots };
  const short = sessionId.slice(0, 8);
  const cases: Case[] = [{ label: `session ${short}`, sessionId, digest: buildDigest(input, policy), focus: { kind: 'session' } }];

  const toolsByTurn = new Map<string, number>();
  for (const e of events) if (e.kind === 'tool_call' && e.turnId) toolsByTurn.set(e.turnId, (toolsByTurn.get(e.turnId) ?? 0) + 1);
  const busiest = [...toolsByTurn].sort((a, b) => b[1] - a[1])[0]?.[0];
  if (busiest) {
    const digest = buildDigest({ ...input, turnId: busiest }, policy);
    if (digest.turns[0]) cases.push({ label: `session ${short}, turn ${digest.turns[0].turn}`, sessionId, digest, focus: { kind: 'turn', turn: digest.turns[0].turn } });
  }
  const finding = findings[0];
  if (finding) {
    const turnId = events.find((e) => finding.eventRefs.includes(e.eventId) && e.turnId)?.turnId;
    const digest = buildDigest({ ...input, ...(turnId ? { turnId } : {}) }, policy);
    const summary = digest.findings.find((f) => f.heuristic === finding.heuristicId)?.summary ?? '';
    cases.push({ label: `session ${short}, ${finding.heuristicId} finding`, sessionId, digest, focus: { kind: 'finding', heuristicId: finding.heuristicId, summary } });
  }
  return cases;
}

function check(text: string, completion: Completion | undefined, messages: ReturnType<typeof explainMessages>): Result['checks'] {
  const lower = text.toLowerCase();
  return {
    headings: HEADINGS.every((h) => lower.includes(h)),
    noAbsolutePaths: !/(^|[\s"'`(])\/(Users|home|private|var|tmp)\//.test(text),
    truncated: !!completion && promptWasCut(completion, messages),
  };
}

/** Asks each model to propose heuristics from one discovery, and reports what the Suggestions tab would keep. */
async function evalPropose(events: NormalizedEvent[], models: string[], baseUrl: string, apiKey: string | undefined, local: boolean, policy: typeof LOCAL_POLICY): Promise<string[]> {
  const report: string[] = [`# Advisor evaluation: propose heuristics`, '', `${new Date().toISOString()} · ${baseUrl} · models: ${models.join(', ')}`, ''];
  for (const model of models) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snagboat-eval-'));
    try {
      const store = new RuleStore(dir);
      await store.load();
      let ms = 0;
      let read: number | undefined;
      let sent = 0;
      let error: string | undefined;
      const controller = new SuggestionsController({
        loadEvents: async () => events,
        options: () => ({ existing: builtInHeuristics(), settingsFor: () => ({}) }),
        store,
        settingsRules: () => ({ origin: 'eval', rules: [], categories: [] }),
        rulesChanged: () => undefined,
        applySetting: async () => undefined,
        dismissed: () => [],
        setDismissed: async () => undefined,
        sessionName: () => undefined,
        propose: async (build) => {
          const messages = proposeMessages(build(policy));
          sent = messages.reduce((n, m) => n + m.content.length, 0);
          const p: ProviderConfig = { id: 'eval', label: 'eval', baseUrl, model, kind: local ? 'local' : 'hosted', policy };
          const started = Date.now();
          try {
            // No JSON mode: Ollama refuses it for some models (qwen3.5) and loops on others; the parser finds the JSON.
            const completion = await complete(p, messages, apiKey, fetch as unknown as FetchLike);
            ms = Date.now() - started;
            read = completion.promptTokens;
            return { text: completion.text, provider: 'eval', model, ...(promptWasCut(completion, messages) ? { warning: 'prompt cut' } : {}) };
          } catch (err) {
            ms = Date.now() - started;
            error = err instanceof Error ? err.message : String(err);
            return undefined;
          }
        },
        roots: () => [process.cwd()],
        source: () => 'eval',
        days: () => 30,
        now: () => new Date().toISOString(),
      });
      await controller.discover();
      await controller.askAdvisor();
      const v = controller.view();
      const named = v.candidates.filter((c) => c.source === 'discovery' && c.named);
      const rules = v.candidates.filter((c) => c.source === 'advisor');
      const categories = v.shell.candidates.filter((c) => c.source === 'advisor');
      console.log(
        `${model.padEnd(20)} ${(ms / 1000).toFixed(1).padStart(6)}s  read ${read ?? '?'} of ~${Math.round(sent / 3.5)} tokens  ` +
          (error ? `error: ${error.slice(0, 80)}` : `named ${named.length}/${v.candidates.filter((c) => c.source === 'discovery').length}, rules kept ${rules.length}, categories kept ${categories.length}, dropped ${v.advisor.problems.length}${v.advisor.warning ? ', PROMPT CUT' : ''}`)
      );
      report.push(`## ${model} (${(ms / 1000).toFixed(1)}s, read ${read ?? '?'} of ~${Math.round(sent / 3.5)} tokens${v.advisor.warning ? ', prompt cut' : ''})`, '');
      if (error) {
        report.push(`Error: ${error}`, '');
        continue;
      }
      report.push('**Names for discovery candidates**', '', ...(named.length ? named.map((c) => `- \`${c.id}\` → **${c.title}**: ${c.summary}${c.suggestedAction ? ` — ${c.suggestedAction}` : ''}`) : ['- none']), '');
      report.push('**Rules it proposed (kept)**', '', ...(rules.length ? rules.map((c) => `- **${c.title}** (\`${c.id}\`): replay ${c.episodes} episodes in ${c.sessions} sessions\n\n  \`\`\`json\n  ${JSON.stringify(c.rule)}\n  \`\`\``) : ['- none']), '');
      report.push('**Shell categories (kept)**', '', ...(categories.length ? categories.map((c) => `- **${c.label}**: ${c.match.join(', ')} (${Math.round(c.share * 100)}% of shell calls)`) : ['- none']), '');
      report.push('**Dropped**', '', ...(v.advisor.problems.length ? v.advisor.problems.map((p) => `- ${p}`) : ['- nothing']), '');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
  return report;
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const models = (arg(args, '--models') ?? '').split(',').map((m) => m.trim()).filter(Boolean);
  const baseUrl = (arg(args, '--base-url') ?? 'http://localhost:11434/v1').replace(/\/+$/, '');
  const sessionCount = Number(arg(args, '--sessions') ?? 2);
  const capability = arg(args, '--capability') ?? 'explain';
  const allAt = args.indexOf('--all-projects');
  if (allAt >= 0) args.splice(allAt, 1);
  if (models.length === 0) {
    console.error('Pass --models, e.g. --models qwen3.5:latest,llama3.1:latest');
    return 1;
  }
  const local = isLocalUrl(baseUrl);
  const apiKey = local ? undefined : process.env.SNAGBOAT_EVAL_API_KEY;
  if (!local && !apiKey) {
    console.error(`${baseUrl} is off this machine: set SNAGBOAT_EVAL_API_KEY.`);
    return 1;
  }
  const policy = local ? LOCAL_POLICY : HOSTED_POLICY;

  const files = args.length > 0 ? args : defaultSessions(allAt >= 0);
  const sessions = files
    .map((f) => sessionEvents(f))
    .filter((events) => new Set(events.filter((e) => e.kind === 'user_prompt').map((e) => e.turnId)).size >= 3)
    .sort((a, b) => b[b.length - 1].ts.localeCompare(a[a.length - 1].ts))
    .slice(0, sessionCount);
  if (sessions.length === 0) {
    console.error('No sessions with 3 or more turns found.');
    return 1;
  }
  if (capability === 'propose') {
    // Discovery wants history, not the latest few sessions: read them all.
    const report = await evalPropose(files.flatMap((f) => sessionEvents(f)), models, baseUrl, apiKey, local, policy);
    const outDir = path.join(process.cwd(), 'out', 'eval');
    fs.mkdirSync(outDir, { recursive: true });
    const file = path.join(outDir, `propose-${new Date().toISOString().replace(/[:.]/g, '-')}.md`);
    fs.writeFileSync(file, report.join('\n') + '\n');
    console.log(`\nReport: ${file}`);
    return 0;
  }
  const cases = sessions.flatMap((events) => casesFor(events, policy, [process.cwd()]));

  const report: string[] = [
    `# Advisor evaluation: Explain`,
    '',
    `${new Date().toISOString()} · ${baseUrl} (${local ? 'local' : 'hosted'} sending rules) · models: ${models.join(', ')}`,
    '',
  ];
  const all: Array<{ c: Case; results: Result[]; chars: number }> = [];
  for (const c of cases) {
    const messages = explainMessages(c.digest, c.focus);
    const chars = messages.reduce((n, m) => n + m.content.length, 0);
    const results: Result[] = [];
    for (const model of models) {
      const p: ProviderConfig = { id: 'eval', label: 'eval', baseUrl, model, kind: local ? 'local' : 'hosted', policy };
      const started = Date.now();
      try {
        const completion = await complete(p, messages, apiKey, fetch as unknown as FetchLike);
        results.push({ model, ms: Date.now() - started, completion, checks: check(completion.text, completion, messages) });
      } catch (err) {
        results.push({ model, ms: Date.now() - started, error: err instanceof Error ? err.message : String(err), checks: { headings: false, noAbsolutePaths: true, truncated: false } });
      }
      const r = results[results.length - 1];
      const flags = r.error ? `error: ${r.error.slice(0, 80)}` : `${r.checks.headings ? 'headings ok' : 'MISSING HEADINGS'}${r.checks.truncated ? ', PROMPT CUT' : ''}${r.checks.noAbsolutePaths ? '' : ', ABSOLUTE PATH'}`;
      console.log(`${c.label.padEnd(40)} ${model.padEnd(20)} ${(r.ms / 1000).toFixed(1).padStart(6)}s  read ${r.completion?.promptTokens ?? '?'} of ~${Math.round(chars / 3.5)} tokens  ${flags}`);
    }
    all.push({ c, results, chars });
  }

  report.push('| Case | Model | Seconds | Prompt tokens read / ~sent | Output tokens | Headings | Prompt cut | Absolute paths |', '| --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const { c, results, chars } of all) {
    for (const r of results) {
      report.push(
        `| ${c.label} | ${r.model} | ${(r.ms / 1000).toFixed(1)} | ${r.completion?.promptTokens ?? '?'} / ${Math.round(chars / 3.5)} | ${r.completion?.completionTokens ?? '?'} | ${r.error ? 'error' : r.checks.headings ? 'yes' : 'no'} | ${r.checks.truncated ? 'yes' : 'no'} | ${r.checks.noAbsolutePaths ? 'none' : 'yes'} |`
      );
    }
  }
  for (const { c, results } of all) {
    report.push('', `## ${c.label}`, '', `<details><summary>Digest (sent compact; indented here)</summary>`, '', '```json', digestForReading(c.digest), '```', '', '</details>');
    for (const r of results) report.push('', `### ${r.model} (${(r.ms / 1000).toFixed(1)}s)`, '', r.error ? `Error: ${r.error}` : r.completion!.text);
  }
  if (all.some(({ results }) => results.some((r) => r.checks.truncated)) && local) {
    report.push('', '> Some prompts were cut to fit the server\'s context window. For Ollama, start it with a larger one, e.g. `OLLAMA_CONTEXT_LENGTH=16384 ollama serve`.');
  }
  const outDir = path.join(process.cwd(), 'out', 'eval');
  fs.mkdirSync(outDir, { recursive: true });
  const file = path.join(outDir, `advisor-${new Date().toISOString().replace(/[:.]/g, '-')}.md`);
  fs.writeFileSync(file, report.join('\n') + '\n');
  console.log(`\nReport: ${file}`);
  return 0;
}

if (require.main === module) main().then((code) => process.exit(code));
