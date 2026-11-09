import { EventToolCategory } from '../schema/toolCategory';
import { AgentId, NormalizedEvent } from '../schema/types';

/**
 * The web demo's example sessions (docs/design/visualization-explorer.md,
 * "Synthetic data"): four sessions of NormalizedEvents shaped like real
 * Claude Code and Copilot ones, from a seeded generator, so every visit draws
 * the same examples. Prompts with turn ids and text, model calls with the
 * four token counts, tool calls with categories, a subagent in some turns,
 * automatic compactions in the long session, idle gaps between prompts, and
 * one turn busy enough on one file to trip the tool-churn heuristic on
 * replay. Nothing here touches the DOM, so it's unit-tested under the root
 * tsconfig.
 */

/** The UTC day the examples happen on. */
export const SYNTHETIC_DAY = '2026-11-02';

interface SessionSpec {
  id: string;
  name?: string;
  agent: AgentId;
  model: string;
  startHour: number;
  turns: number;
  /** Context growth per model call, tokens; the Copilot session's budget is small, so it grows slowly. */
  growth: [number, number];
  /** Context at which the agent compacts automatically; none for Copilot, which reports its budget instead. */
  compactAt?: number;
  contextLimit?: number;
  /** The one-based turn that edits the same file over and over. */
  churnTurn?: number;
  /** One-based turns that delegate part of the work to a subagent. */
  subagentTurns: number[];
}

const SPECS: SessionSpec[] = [
  { id: '7f3a9c2e-5d1b-4e8a-9c0f-2b6d8e1a4c73', name: 'Explorer carousel', agent: 'claude-code', model: 'claude-opus-4-1-20250805', startHour: 9, turns: 14, growth: [3_000, 21_000], compactAt: 190_000, churnTurn: 6, subagentTurns: [3, 9, 12] },
  { id: 'b41d0e77-8a2c-4f61-b3e5-7d9f0c2a6e18', name: 'Fix hook routing', agent: 'claude-code', model: 'claude-sonnet-4-5-20250929', startHour: 11, turns: 7, growth: [3_000, 15_000], compactAt: 190_000, subagentTurns: [4] },
  { id: 'c9a2f118-3e7d-4b05-a6c1-5f8e2d7b9a40', name: 'README pass', agent: 'copilot', model: 'gpt-5.2', startHour: 13, turns: 6, growth: [800, 3_500], contextLimit: 128_000, subagentTurns: [] },
  { id: '1e8d5b60-9c4f-4a27-8d3b-0e6a1f5c7b92', agent: 'claude-code', model: 'claude-sonnet-4-5-20250929', startHour: 15, turns: 5, growth: [3_000, 12_000], compactAt: 190_000, subagentTurns: [] },
];

const PROMPTS = [
  'fix the failing unit test in retention',
  'add a changelog section for 0.0.3',
  'why is the status bar showing zero tokens',
  'refactor sessionController to hold a set',
  'run the integration suite',
  'write the usage section for the explorer',
  'commit and push',
  'the tooltip is clipped at the right edge; keep it inside the window',
  'summarize what changed in src/core since the last tag',
];

const TOOLS: Record<AgentId, Array<{ name: string; category: EventToolCategory; target: string }>> = {
  'claude-code': [
    { name: 'Read', category: 'file-read', target: 'src/core/retention.ts' },
    { name: 'Read', category: 'file-read', target: 'src/core/eventLog.ts' },
    { name: 'Read', category: 'file-read', target: 'docs/usage.md' },
    { name: 'Grep', category: 'search', target: 'applyRetention' },
    { name: 'Glob', category: 'search', target: 'src/**/*.test.ts' },
    { name: 'Edit', category: 'file-edit', target: 'src/core/retention.ts' },
    { name: 'Edit', category: 'file-edit', target: 'src/test/unit/retention.unit.test.ts' },
    { name: 'Edit', category: 'file-edit', target: 'CHANGELOG.md' },
    { name: 'Write', category: 'file-edit', target: 'docs/usage.md' },
    { name: 'Bash', category: 'tests-builds', target: 'npm run test:unit' },
    { name: 'Bash', category: 'tests-builds', target: 'npm run build' },
    { name: 'Bash', category: 'version-control', target: 'git status --short' },
    { name: 'Bash', category: 'version-control', target: 'git diff --stat' },
    { name: 'Bash', category: 'script', target: 'node scripts/licenses.js' },
    { name: 'Bash', category: 'shell', target: 'ls -la out' },
  ],
  copilot: [
    { name: 'read_file', category: 'file-read', target: 'README.md' },
    { name: 'read_file', category: 'file-read', target: 'docs/usage.md' },
    { name: 'read_file', category: 'file-read', target: 'package.json' },
    { name: 'grep_search', category: 'search', target: 'Explore' },
    { name: 'file_search', category: 'search', target: 'docs/**/*.md' },
    { name: 'edit_file', category: 'file-edit', target: 'README.md' },
    { name: 'edit_file', category: 'file-edit', target: 'docs/usage.md' },
    { name: 'run_in_terminal', category: 'tests-builds', target: 'npm run build' },
    { name: 'run_in_terminal', category: 'version-control', target: 'git log --oneline -5' },
  ],
  'generic-fs': [],
};

/** The tool the churn turn keeps calling. */
const CHURN_TOOL = TOOLS['claude-code'][5];

/** Park-Miller, as the wireframe used: a tiny generator with the same sequence everywhere. */
function prng(seed: number): () => number {
  let s = seed;
  return () => (s = (s * 16807) % 2147483647) / 2147483647;
}

const MINUTE = 60_000;
const SECOND = 1_000;

/** The four example sessions' events, in time order within each session. Deterministic. */
export function syntheticEvents(): NormalizedEvent[] {
  const rnd = prng(7);
  const out: NormalizedEvent[] = [];
  for (const spec of SPECS) out.push(...sessionEvents(spec, rnd));
  return out;
}

/** The example sessions' ids, in the order generated. */
export function syntheticSessionIds(): string[] {
  return SPECS.map((s) => s.id);
}

function sessionEvents(spec: SessionSpec, rnd: () => number): NormalizedEvent[] {
  const events: NormalizedEvent[] = [];
  const short = spec.id.slice(0, 8);
  let n = 0;
  const base = { sessionId: spec.id, agent: spec.agent, raw: { adapter: 'example', ref: 'synthetic' } } as const;
  const push = (ts: number, partial: Omit<NormalizedEvent, 'eventId' | 'sessionId' | 'agent' | 'ts' | 'raw' | 'status'> & { status?: NormalizedEvent['status'] }) => {
    events.push({ eventId: `${short}-${(n++).toString().padStart(4, '0')}`, ts: new Date(ts).toISOString(), status: 'unknown', ...base, ...partial });
  };
  const tokens = (ctx: number, output: number) => ({ input: Math.round(ctx * 0.08), cacheRead: Math.round(ctx * 0.8), cacheCreation: Math.round(ctx * 0.12), output: Math.round(output) });
  const tools = TOOLS[spec.agent];
  const [year, month, day] = SYNTHETIC_DAY.split('-').map(Number);
  let t = Date.UTC(year, month - 1, day, spec.startHour, 0);
  let ctx = 20_000 + rnd() * 30_000;

  if (spec.name) push(t - 5 * SECOND, { kind: 'session_name', sessionName: spec.name });

  for (let p = 1; p <= spec.turns; p++) {
    // Idle gaps: most prompts follow within minutes, a few after a long break.
    if (p > 1) t += (rnd() < 0.15 ? 40 + rnd() * 90 : 1 + rnd() * 8) * MINUTE;
    const turnId = `${short}-turn-${p}`;
    const churn = spec.churnTurn === p;
    push(t, { kind: 'user_prompt', turnId, promptText: churn ? 'make the retention test pass without changing its expectations' : PROMPTS[(SPECS.indexOf(spec) * 7 + p) % PROMPTS.length] });
    t += 2 * SECOND + rnd() * 5 * SECOND;

    const nCalls = churn ? 12 : 2 + Math.floor(rnd() * 9);
    for (let c = 0; c < nCalls; c++) {
      ctx += spec.growth[0] + rnd() * (spec.growth[1] - spec.growth[0]);
      if (spec.compactAt && ctx > spec.compactAt) {
        const post = 45_000 + rnd() * 15_000;
        push(t, { kind: 'compaction', model: spec.model, compaction: { trigger: 'auto', preTokens: Math.round(ctx), postTokens: Math.round(post) } });
        ctx = post;
        t += 8 * SECOND;
      }
      t += 15 * SECOND + rnd() * (churn ? 10 : 60) * SECOND;
      const last = c === nCalls - 1;
      push(t, { kind: 'turn_stop', turnId, model: spec.model, status: 'success', tokens: tokens(ctx, 200 + rnd() * 2_500), ...(spec.contextLimit ? { contextLimit: spec.contextLimit } : {}), ...(last ? { endsTurn: true as const } : {}) });
      if (!last) {
        // Each call but the last asked for one or two tools; the churn turn keeps editing the same file.
        const count = churn ? 1 : 1 + Math.floor(rnd() * 2);
        for (let k = 0; k < count; k++) {
          const tool = churn ? CHURN_TOOL : tools[Math.floor(rnd() * tools.length)];
          t += 3 * SECOND + rnd() * 10 * SECOND;
          push(t, { kind: 'tool_call', turnId, toolName: tool.name, toolCategory: tool.category, target: tool.target, status: rnd() < 0.92 ? 'success' : 'failure' });
        }
      }
    }

    if (spec.subagentTurns.includes(p)) {
      // A subagent did part of the turn: its own calls and tools, interleaved before the turn ended.
      const agentId = `agent-${(0x2a7f1c + p * 0x1f3d).toString(16)}${short.slice(0, 3)}`;
      let st = t - (nCalls * 20 + 10) * SECOND;
      let sctx = 8_000 + rnd() * 6_000;
      const subCalls = 2 + Math.floor(rnd() * 3);
      for (let c = 0; c < subCalls; c++) {
        sctx += 2_000 + rnd() * 9_000;
        st += 12 * SECOND + rnd() * 30 * SECOND;
        push(st, { kind: 'turn_stop', turnId, agentId, model: spec.model, status: 'success', tokens: tokens(sctx, 150 + rnd() * 1_200) });
        const tool = tools[Math.floor(rnd() * tools.length)];
        st += 2 * SECOND + rnd() * 6 * SECOND;
        push(st, { kind: 'tool_call', turnId, agentId, toolName: tool.name, toolCategory: tool.category, target: tool.target, status: 'success' });
      }
    }
  }
  return events.sort((a, b) => a.ts.localeCompare(b.ts) || a.eventId.localeCompare(b.eventId));
}
