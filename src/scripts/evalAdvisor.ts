/**
 * Runs an advisor ability over digests of your own sessions with several
 * models or advisors, and writes their answers side by side, so default
 * models and prompts are picked from real use. Dev tooling only; never shipped.
 *
 *   npm run eval:advisor -- --models qwen3.5:latest,llama3.1:latest [--base-url <url>] [--ability summarize-session|propose-tactics|propose-heuristics] [--prompts both|on|off] [--sessions 2] [--all-projects | <session.jsonl> ...]
 *   npm run eval:advisor -- --advisor spend,risk [--settings <settings.json>] [--ability ...] ...
 *
 * --models asks each model at --base-url (Ollama on this machine by default)
 * with Snagboat's default prompts and the address's sending rules. --advisor
 * asks advisors from your VS Code settings instead (snagboat.advisors and
 * snagboat.advisor.providers, read from the user settings.json or --settings),
 * each with its own model, sending rules, persona, and prompt files, so two
 * advisors on the same model compare two prompt sets on the same digests.
 * Each advisor needs its "model" set.
 *
 * --ability propose-heuristics (or the older "propose") runs discovery over
 * the sessions and asks each run to name its candidates, propose rules, and
 * group shell commands, through the Suggestions tab's own controller, so
 * what's kept or dropped is exactly what the tab would show.
 *
 * --prompts (summarize-session only; default both) runs each case with and
 * without the turns' prompt text, so the gain from prompts is measured, not
 * assumed. A hosted run never gets prompts its sending rules withhold.
 *
 * A provider off this machine needs SNAGBOAT_EVAL_API_KEY.
 *
 * For summarize-session, each session gives up to three cases: the session,
 * its busiest turn, and its first finding; for propose-tactics, one case per
 * session. Answers are checked automatically (the ability's three headings,
 * no absolute paths, whether the server cut the prompt to fit its context
 * window); judging quality is yours, from the report. The
 * console gets counts and timings only. The report, with digests and answers,
 * is written to out/eval/, which isn't committed.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { Capability } from '../advisor/advisors';
import { buildDigest, digestForReading, DigestFinding, DigestPolicy, HOSTED_POLICY, LOCAL_POLICY, SessionDigest } from '../advisor/digest';
import { PromptLayers } from '../advisor/prompts';
import { proposeHeuristicsMessages, weakAction } from '../advisor/proposeHeuristics';
import { heuristicEffectiveness } from '../review/effectiveness';
import { proposeTacticsMessages } from '../advisor/proposeTactics';
import { complete, Completion, FetchLike, isLocalUrl, promptWasCut, ProviderConfig } from '../advisor/providers';
import { SessionFocus, summarizeSessionMessages } from '../advisor/summarizeSession';
import { builtInHeuristics } from '../heuristics/builtIns';
import { FindingReplay } from '../heuristics/replay';
import { RuleStore } from '../heuristics/ruleStore';
import { NormalizedEvent } from '../core/types';
import { SuggestionsController } from '../ui/suggestionsController';
import { advisorsFromSettings } from './advisorSettings';
import { defaultSessions, sessionEvents } from './replayHeuristics';

/** One thing to ask: a model with default prompts, or an advisor from settings. */
export interface Run {
  label: string;
  provider: ProviderConfig;
  apiKey?: string;
  /** Undefined when the advisor doesn't offer the ability. */
  policy(ability: Capability): DigestPolicy | undefined;
  prompts(ability: Capability): PromptLayers;
}

interface Case {
  label: string;
  sessionId: string;
  digest: SessionDigest;
  focus: SessionFocus;
}

interface Result {
  run: Run;
  ms: number;
  completion?: Completion;
  error?: string;
  checks: { headings: boolean; noAbsolutePaths: boolean; truncated: boolean };
}

/** The Markdown abilities this script runs case by case: their headings, and how a case's messages are built. */
const CASE_ABILITIES: Record<string, { ability: Capability; headings: string[]; sessionOnly: boolean; messages: (c: Case, run: Run) => ReturnType<typeof summarizeSessionMessages> }> = {
  'summarize-session': { ability: 'summarize-session', headings: ['what happened', 'likely cause', 'what to try'], sessionOnly: false, messages: (c, run) => summarizeSessionMessages(c.digest, c.focus, run.prompts('summarize-session')) },
  'propose-tactics': { ability: 'propose-tactics', headings: ['model use', 'prompt tactics', 'what to try'], sessionOnly: true, messages: (c, run) => proposeTacticsMessages([c.digest], run.prompts('propose-tactics')) },
};

function arg(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const v = args[i + 1];
  args.splice(i, 2);
  return v;
}

function flag(args: string[], name: string): boolean {
  const i = args.indexOf(name);
  if (i >= 0) args.splice(i, 1);
  return i >= 0;
}

/** The runs from --models or --advisor; a readable error when neither works. */
export function runsFromArgs(models: string[], baseUrl: string, advisorIds: string[], settingsFile: string | undefined): Run[] {
  const hostedKey = process.env.SNAGBOAT_EVAL_API_KEY;
  if (advisorIds.length > 0) {
    return advisorsFromSettings(advisorIds, settingsFile).map(({ advisor, prompts }) => {
      if (!advisor.model) throw new Error(`advisor "${advisor.id}" has no model set; set "model" in its settings entry`);
      if (advisor.locality === 'hosted' && !hostedKey) throw new Error(`advisor "${advisor.id}" is off this machine: set SNAGBOAT_EVAL_API_KEY`);
      return {
        label: `${advisor.id} (${advisor.model})`,
        provider: advisor,
        ...(advisor.locality === 'hosted' ? { apiKey: hostedKey } : {}),
        policy: (ability) => advisor.abilities[ability]?.policy,
        prompts,
      };
    });
  }
  if (models.length === 0) throw new Error('pass --models, e.g. --models qwen3.5:latest,llama3.1:latest, or --advisor <id> from your settings');
  const local = isLocalUrl(baseUrl);
  if (!local && !hostedKey) throw new Error(`${baseUrl} is off this machine: set SNAGBOAT_EVAL_API_KEY`);
  const policy = local ? LOCAL_POLICY : HOSTED_POLICY;
  return models.map((model) => ({
    label: model,
    provider: { id: 'eval', label: 'eval', baseUrl, model, locality: local ? 'local' : 'hosted', policy },
    ...(local ? {} : { apiKey: hostedKey }),
    policy: () => policy,
    prompts: () => ({}),
  }));
}

/** Up to three cases per session: the whole session, its busiest turn, and its first finding (or the session only). */
function casesFor(events: NormalizedEvent[], policy: DigestPolicy, roots: string[], sessionOnly = false): Case[] {
  const sessionId = events[0].sessionId;
  const replay = new FindingReplay(builtInHeuristics(), () => ({}));
  for (const e of events) replay.ingest(e);
  const findings: DigestFinding[] = replay.episodes().map((e) => ({ heuristicId: e.heuristicId, severity: e.severity, summary: e.summary, startTs: e.startTs, endTs: e.endTs, eventRefs: e.eventRefs }));
  const input = { sessionId, events, findings, roots };
  const short = sessionId.slice(0, 8);
  const cases: Case[] = [{ label: `session ${short}`, sessionId, digest: buildDigest(input, policy), focus: { kind: 'session' } }];
  if (sessionOnly) return cases;

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

function check(text: string, completion: Completion | undefined, messages: ReturnType<typeof summarizeSessionMessages>, headings: string[]): Result['checks'] {
  const lower = text.toLowerCase();
  return {
    headings: headings.every((h) => lower.includes(h)),
    noAbsolutePaths: !/(^|[\s"'`(])\/(Users|home|private|var|tmp)\//.test(text),
    truncated: !!completion && promptWasCut(completion, messages),
  };
}

const describePolicy = (p: DigestPolicy) => `${[p.prompts && 'prompts', p.replies && 'replies', p.sessionNames && 'session names'].filter(Boolean).join(', ') || 'no text'}; paths ${p.paths}`;

/** Asks each run to propose heuristics from one discovery, and reports what the Suggestions tab would keep. */
async function evalPropose(events: NormalizedEvent[], runs: Run[]): Promise<string[]> {
  const report: string[] = [`# Advisor evaluation: propose heuristics`, '', `${new Date().toISOString()} · runs: ${runs.map((r) => r.label).join(', ')}`, ''];
  for (const run of runs) {
    const policy = run.policy('propose-heuristics');
    if (!policy) {
      console.log(`${run.label.padEnd(30)} doesn't offer propose-heuristics`);
      report.push(`## ${run.label}`, '', "Doesn't offer propose-heuristics.", '');
      continue;
    }
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
        // No recorded responses or mutes outside the extension: episodes only.
        effectiveness: async (evs) => heuristicEffectiveness(evs, builtInHeuristics(), () => ({}), undefined, [], []).rows.map((r) => ({ id: r.id, builtIn: true, episodes: r.episodes, warnings: r.warnings, sessions: r.sessions, muted: false })),
        propose: async (build) => {
          const messages = proposeHeuristicsMessages(build(policy), run.prompts('propose-heuristics'));
          sent = messages.reduce((n, m) => n + m.content.length, 0);
          const started = Date.now();
          try {
            // No JSON mode: Ollama refuses it for some models (qwen3.5) and loops on others; the parser finds the JSON.
            const completion = await complete(run.provider, messages, run.apiKey, fetch as unknown as FetchLike);
            ms = Date.now() - started;
            read = completion.promptTokens;
            return { text: completion.text, provider: run.label, model: run.provider.model, ...(promptWasCut(completion, messages) ? { warning: 'prompt cut' } : {}) };
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
        `${run.label.padEnd(30)} ${(ms / 1000).toFixed(1).padStart(6)}s  read ${read ?? '?'} of ~${Math.round(sent / 3.5)} tokens  ` +
          (error ? `error: ${error.slice(0, 80)}` : `named ${named.length}/${v.candidates.filter((c) => c.source === 'discovery').length}, rules kept ${rules.length}, categories kept ${categories.length}, dropped ${v.advisor.problems.length}${v.advisor.warning ? ', PROMPT CUT' : ''}`)
      );
      report.push(`## ${run.label} (${(ms / 1000).toFixed(1)}s, read ${read ?? '?'} of ~${Math.round(sent / 3.5)} tokens${v.advisor.warning ? ', prompt cut' : ''}; sends ${describePolicy(policy)})`, '');
      if (error) {
        report.push(`Error: ${error}`, '');
        continue;
      }
      // Actionability is the person's call; "weak?" flags an action that only says to look.
      const judge = (action: string | undefined) => `${weakAction(action ?? '') ? ' *(weak action?)*' : ''} ☐ actionable`;
      report.push('**Names for discovery candidates** (judge each: does the summary name a cause and the action something to do?)', '', ...(named.length ? named.map((c) => `- \`${c.id}\` → **${c.title}**: ${c.summary}${c.suggestedAction ? ` — ${c.suggestedAction}` : ''}${judge(c.suggestedAction)}`) : ['- none']), '');
      report.push('**Rules it proposed (kept)**', '', ...(rules.length ? rules.map((c) => `- **${c.title}** (\`${c.id}\`): replay ${c.episodes} episodes in ${c.sessions} sessions${judge(c.suggestedAction)}\n\n  \`\`\`json\n  ${JSON.stringify(c.rule)}\n  \`\`\``) : ['- none']), '');
      report.push('**Retire and threshold proposals**', '', ...(v.advisor.retire.length || v.advisor.thresholds.length ? [...v.advisor.retire.map((r) => `- retire \`${r.id}\`: ${r.reason}`), ...v.advisor.thresholds.map((t) => `- ${t.heuristic} ${t.setting}: ${t.current} → ${t.value}: ${t.reason}`)] : ['- none']), '');
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
  const advisorIds = (arg(args, '--advisor') ?? '').split(',').map((m) => m.trim()).filter(Boolean);
  const settingsFile = arg(args, '--settings');
  const baseUrl = (arg(args, '--base-url') ?? 'http://localhost:11434/v1').replace(/\/+$/, '');
  const sessionCount = Number(arg(args, '--sessions') ?? 2);
  const ability = arg(args, '--ability') ?? arg(args, '--capability') ?? 'summarize-session';
  const promptsMode = arg(args, '--prompts') ?? 'both';
  const allProjects = flag(args, '--all-projects');
  if (!['both', 'on', 'off'].includes(promptsMode)) {
    console.error('--prompts takes both, on, or off');
    return 1;
  }
  let runs: Run[];
  try {
    runs = runsFromArgs(models, baseUrl, advisorIds, settingsFile);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }

  const files = args.length > 0 ? args : defaultSessions(allProjects);
  const sessions = files
    .map((f) => sessionEvents(f))
    .filter((events) => new Set(events.filter((e) => e.kind === 'user_prompt').map((e) => e.turnId)).size >= 3)
    .sort((a, b) => b[b.length - 1].ts.localeCompare(a[a.length - 1].ts))
    .slice(0, sessionCount);
  if (sessions.length === 0) {
    console.error('No sessions with 3 or more turns found.');
    return 1;
  }
  const outDir = path.join(process.cwd(), 'out', 'eval');
  fs.mkdirSync(outDir, { recursive: true });
  if (ability === 'propose-heuristics' || ability === 'propose') {
    // Discovery wants history, not the latest few sessions: read them all.
    const report = await evalPropose(files.flatMap((f) => sessionEvents(f)), runs);
    const file = path.join(outDir, `propose-${new Date().toISOString().replace(/[:.]/g, '-')}.md`);
    fs.writeFileSync(file, report.join('\n') + '\n');
    console.log(`\nReport: ${file}`);
    return 0;
  }

  const spec = CASE_ABILITIES[ability];
  if (!spec) {
    console.error(`--ability takes ${[...Object.keys(CASE_ABILITIES), 'propose-heuristics'].join(', ')}`);
    return 1;
  }
  // With and without prompts, as --prompts says; a run whose rules withhold prompts (hosted, by default) never gets them.
  const variants = promptsMode === 'both' ? [true, false] : [promptsMode === 'on'];
  runs = runs.flatMap((run) =>
    variants
      .filter((withPrompts) => !withPrompts || run.provider.locality === 'local' || run.policy(spec.ability)?.prompts)
      .map((withPrompts): Run => ({
        ...run,
        label: variants.length > 1 ? `${run.label} · ${withPrompts ? 'prompts' : 'no prompts'}` : run.label,
        policy: (a) => {
          const p = run.policy(a);
          return p && { ...p, prompts: withPrompts };
        },
      }))
  );
  const report: string[] = [`# Advisor evaluation: ${spec.ability}`, '', `${new Date().toISOString()} · runs: ${runs.map((r) => `${r.label} (${r.provider.baseUrl}; sends ${describePolicy(r.policy(spec.ability) ?? HOSTED_POLICY)})`).join(', ')}`, ''];
  // Each run gets digests under its own sending rules; the report shows the first run's.
  const casesByRun = runs.map((run) => {
    const policy = run.policy(spec.ability);
    return policy ? sessions.flatMap((events) => casesFor(events, policy, [process.cwd()], spec.sessionOnly)) : [];
  });
  const shown = casesByRun.find((c) => c.length > 0) ?? [];
  const all: Array<{ c: Case; results: Result[] }> = [];
  for (const [i, c] of shown.entries()) {
    const results: Result[] = [];
    for (const [r, run] of runs.entries()) {
      const mine = casesByRun[r][i];
      if (!mine) {
        console.log(`${c.label.padEnd(40)} ${run.label.padEnd(30)} doesn't offer ${spec.ability}`);
        continue;
      }
      const messages = spec.messages(mine, run);
      const chars = messages.reduce((n, m) => n + m.content.length, 0);
      const started = Date.now();
      try {
        const completion = await complete(run.provider, messages, run.apiKey, fetch as unknown as FetchLike);
        results.push({ run, ms: Date.now() - started, completion, checks: check(completion.text, completion, messages, spec.headings) });
      } catch (err) {
        results.push({ run, ms: Date.now() - started, error: err instanceof Error ? err.message : String(err), checks: { headings: false, noAbsolutePaths: true, truncated: false } });
      }
      const res = results[results.length - 1];
      const flags = res.error ? `error: ${res.error.slice(0, 80)}` : `${res.checks.headings ? 'headings ok' : 'MISSING HEADINGS'}${res.checks.truncated ? ', PROMPT CUT' : ''}${res.checks.noAbsolutePaths ? '' : ', ABSOLUTE PATH'}`;
      console.log(`${c.label.padEnd(40)} ${run.label.padEnd(30)} ${(res.ms / 1000).toFixed(1).padStart(6)}s  read ${res.completion?.promptTokens ?? '?'} of ~${Math.round(chars / 3.5)} tokens  ${flags}`);
    }
    all.push({ c, results });
  }

  report.push('| Case | Run | Seconds | Prompt tokens read | Output tokens | Headings | Prompt cut | Absolute paths |', '| --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const { c, results } of all) {
    for (const r of results) {
      report.push(`| ${c.label} | ${r.run.label} | ${(r.ms / 1000).toFixed(1)} | ${r.completion?.promptTokens ?? '?'} | ${r.completion?.completionTokens ?? '?'} | ${r.error ? 'error' : r.checks.headings ? 'yes' : 'no'} | ${r.checks.truncated ? 'yes' : 'no'} | ${r.checks.noAbsolutePaths ? 'none' : 'yes'} |`);
    }
  }
  for (const { c, results } of all) {
    report.push('', `## ${c.label}`, '', `<details><summary>Digest (sent compact; indented here; under the first run's sending rules)</summary>`, '', '```json', digestForReading(c.digest), '```', '', '</details>');
    for (const r of results) report.push('', `### ${r.run.label} (${(r.ms / 1000).toFixed(1)}s)`, '', r.error ? `Error: ${r.error}` : r.completion!.text);
  }
  if (all.some(({ results }) => results.some((r) => r.checks.truncated && r.run.provider.locality === 'local'))) {
    report.push('', '> Some prompts were cut to fit the server\'s context window. For Ollama, start it with a larger one, e.g. `OLLAMA_CONTEXT_LENGTH=16384 ollama serve`.');
  }
  const file = path.join(outDir, `advisor-${new Date().toISOString().replace(/[:.]/g, '-')}.md`);
  fs.writeFileSync(file, report.join('\n') + '\n');
  console.log(`\nReport: ${file}`);
  return 0;
}

if (require.main === module) main().then((code) => process.exit(code));
