import { contextSize, ModelContextMarks } from '../core/contextLimits';
import { eventTokens, isConversationEvent, SessionSummary } from '../core/sessions';
import { NormalizedEvent } from '../core/types';
import { TOOL_CATEGORY_LABELS, ToolCategory } from '../core/toolCategory';

/**
 * Everything the session view (turn tree above a context timeline; see
 * docs/design/conversation-view.md) needs for one session. Built in the
 * extension, sent whole to the webview.
 */

export interface TimelineCall {
  ts: string;
  turnId?: string;
  agentId?: string;
  model?: string;
  input: number;
  cacheRead: number;
  cacheCreation: number;
  output: number;
}

export interface TreeNode {
  /** Stable path id, e.g. "s/p3/main/script". */
  id: string;
  label: string;
  kind: 'session' | 'prompt' | 'agent' | 'category';
  tokens: number;
  /** True when the value is an approximation (tool-category crediting). */
  approximate?: boolean;
  turnId?: string;
  agentId?: string;
  /** Which of two alternating shades the node's turn takes, so neighboring turns contrast. Unset for Unlinked. */
  shade?: 0 | 1;
  /** Category nodes: color slot from CATEGORY_COLOR_GROUPS (1-5), or 0 for the neutral rest. */
  colorGroup?: number;
  /** Finding badges on this node: heuristic ids with their worst severity. */
  findings?: Array<{ heuristicId: string; severity: 'info' | 'warn' }>;
  children: TreeNode[];
}

export interface SessionFindingMark {
  heuristicId: string;
  severity: 'info' | 'warn';
  summary: string;
  /** Span of the finding: the events behind it, plus when it was reporting, when known. */
  fromTs?: string;
  toTs?: string;
  turnIds: string[];
  /** When it started reporting, if known (replayed episodes); else fromTs. */
  startedTs?: string;
  /** Reporting now (from the live engine); otherwise found by replaying the session. */
  active: boolean;
}

export interface SessionView {
  summary: SessionSummary;
  /** Every prompt message; several can share a turn, and share its index. */
  prompts: Array<{ turnId: string; ts: string; index: number }>;
  calls: TimelineCall[];
  compactions: Array<{ ts: string; trigger: string; preTokens?: number; postTokens?: number }>;
  subagents: Array<{ agentId: string; firstTs: string; lastTs: string; calls: number }>;
  /** Per model used in this session: largest context seen and encountered limit (all workspaces). */
  marks: Record<string, ModelContextMarks>;
  findings: SessionFindingMark[];
  tree: TreeNode;
  /** Legend labels for colorGroup 1-5. */
  categoryGroups: string[];
}

export interface FindingInput {
  heuristicId: string;
  severity: 'info' | 'warn';
  summary: string;
  eventRefs: string[];
  /** When it was reporting (replayed episodes). */
  startTs?: string;
  endTs?: string;
  active: boolean;
}

/**
 * Tool categories folded into five colors, in the order they're drawn within a
 * block. Only five hues stay distinct, including for colorblind readers, when
 * any two can end up side by side (one missing category puts non-neighbors
 * together); the order was validated for neighbors and next-but-one neighbors
 * in both themes. Everything else is neutral and drawn last.
 */
export const CATEGORY_COLOR_GROUPS: Array<{ label: string; categories: ToolCategory[] }> = [
  { label: 'File edit', categories: ['file-edit'] },
  { label: 'Read and search', categories: ['file-read', 'search'] },
  { label: 'Script', categories: ['script'] },
  { label: 'Tests and builds', categories: ['tests-builds'] },
  { label: 'Shell and version control', categories: ['shell', 'version-control'] },
];

export function categoryColorGroup(category: ToolCategory): number {
  return CATEGORY_COLOR_GROUPS.findIndex((g) => g.categories.includes(category)) + 1;
}

/** Display name for a subagent: Claude Code ids are long hashes, so keep a short prefix. */
function agentLabel(agentId: string): string {
  return `subagent ${agentId.replace(/^agent-/, '').slice(0, 7)}`;
}

/**
 * Splits a block's tokens across tool categories in proportion to how many
 * calls of each category it made. An approximation (the design's per-call
 * crediting needs links from tool calls to the model call that requested
 * them, which not every source provides); always flagged as approximate.
 */
function categoryChildren(parentId: string, tokens: number, tools: NormalizedEvent[], shade: 0 | 1 | undefined): TreeNode[] {
  if (tokens <= 0) return [];
  if (tools.length === 0) {
    return [{ id: `${parentId}/reply`, label: 'Replies only', kind: 'category', tokens, approximate: true, shade, colorGroup: 0, children: [] }];
  }
  // Fixed color-group order (neutral last), then largest first within a group.
  const rank = (c: ToolCategory) => categoryColorGroup(c) || CATEGORY_COLOR_GROUPS.length + 1;
  const counts = new Map<ToolCategory, number>();
  for (const t of tools) counts.set(t.toolCategory ?? 'other', (counts.get(t.toolCategory ?? 'other') ?? 0) + 1);
  return [...counts]
    .sort((a, b) => rank(a[0]) - rank(b[0]) || b[1] - a[1])
    .map(([category, n]) => ({
      id: `${parentId}/${category}`,
      label: TOOL_CATEGORY_LABELS[category],
      kind: 'category' as const,
      tokens: Math.round((tokens * n) / tools.length),
      approximate: true,
      shade,
      colorGroup: categoryColorGroup(category),
      children: [],
    }));
}

export function buildSessionView(
  summary: SessionSummary,
  sessionEvents: NormalizedEvent[],
  marks: Record<string, ModelContextMarks>,
  sessionFindings: FindingInput[] = []
): SessionView {
  const events = sessionEvents.filter((e) => e.sessionId === summary.sessionId && isConversationEvent(e)).sort((a, b) => a.ts.localeCompare(b.ts));

  // Turns in order of their first prompt; a later message in the same turn keeps its number.
  const promptIndex = new Map<string, number>();
  for (const e of events) if (e.kind === 'user_prompt' && e.turnId && !promptIndex.has(e.turnId)) promptIndex.set(e.turnId, promptIndex.size + 1);
  const prompts = events.filter((e) => e.kind === 'user_prompt' && e.turnId).map((e) => ({ turnId: e.turnId!, ts: e.ts, index: promptIndex.get(e.turnId!)! }));

  const callEvents = events.filter((e) => e.kind === 'turn_stop' && e.tokens);
  const calls: TimelineCall[] = callEvents.map((e) => ({
    ts: e.ts,
    turnId: e.turnId,
    agentId: e.agentId,
    model: e.model,
    input: e.tokens?.input ?? 0,
    cacheRead: e.tokens?.cacheRead ?? 0,
    cacheCreation: e.tokens?.cacheCreation ?? 0,
    output: e.tokens?.output ?? 0,
  }));

  const compactions = events
    .filter((e) => e.kind === 'compaction')
    .map((e) => ({ ts: e.ts, trigger: e.compaction?.trigger ?? 'unknown', preTokens: e.compaction?.preTokens, postTokens: e.compaction?.postTokens }));

  const subagentMap = new Map<string, { firstTs: string; lastTs: string; calls: number }>();
  for (const e of events) {
    if (!e.agentId) continue;
    const s = subagentMap.get(e.agentId) ?? { firstTs: e.ts, lastTs: e.ts, calls: 0 };
    if (e.ts < s.firstTs) s.firstTs = e.ts;
    if (e.ts > s.lastTs) s.lastTs = e.ts;
    if (e.kind === 'turn_stop' && e.tokens) s.calls += 1;
    subagentMap.set(e.agentId, s);
  }
  const subagents = [...subagentMap].map(([agentId, s]) => ({ agentId, ...s })).sort((a, b) => a.firstTs.localeCompare(b.firstTs));

  const usedModels = new Set(calls.map((c) => c.model).filter((m): m is string => !!m));
  const sessionMarks: Record<string, ModelContextMarks> = {};
  for (const m of usedModels) if (marks[m]) sessionMarks[m] = marks[m];

  // Findings that point at this session's events.
  const byId = new Map(events.map((e) => [e.eventId, e]));
  const findings: SessionFindingMark[] = [];
  for (const f of sessionFindings) {
    const refs = f.eventRefs.map((id) => byId.get(id)).filter((e): e is NormalizedEvent => !!e);
    if (refs.length === 0) continue;
    const times = [...refs.map((e) => e.ts), ...(f.startTs ? [f.startTs] : []), ...(f.endTs ? [f.endTs] : [])].sort();
    findings.push({
      heuristicId: f.heuristicId,
      severity: f.severity,
      summary: f.summary,
      fromTs: times[0],
      toTs: times[times.length - 1],
      turnIds: [...new Set(refs.map((e) => e.turnId).filter((t): t is string => !!t))],
      startedTs: f.startTs,
      active: f.active,
    });
  }
  findings.sort((a, b) => (a.startedTs ?? a.fromTs ?? '').localeCompare(b.startedTs ?? b.fromTs ?? ''));

  // Tree: session -> prompts -> agents -> tool categories.
  const tokensBy = (pred: (e: NormalizedEvent) => boolean) => callEvents.filter(pred).reduce((sum, e) => sum + eventTokens(e), 0);
  const turnOrder = [...promptIndex.keys()];
  const orphanCalls = callEvents.some((e) => !e.turnId || !promptIndex.has(e.turnId));
  const promptNodes: TreeNode[] = [];
  const turnKeys: Array<string | undefined> = orphanCalls ? [undefined, ...turnOrder] : turnOrder;
  for (const turnId of turnKeys) {
    const inTurn = (e: NormalizedEvent) => (turnId === undefined ? !e.turnId || !promptIndex.has(e.turnId) : e.turnId === turnId);
    const turnTokens = tokensBy(inTurn);
    const pid = turnId === undefined ? 's/unlinked' : `s/p${promptIndex.get(turnId)}`;
    const shade = turnId === undefined ? undefined : ((promptIndex.get(turnId)! % 2) as 0 | 1);
    const agentIds = [undefined, ...new Set(events.filter((e) => inTurn(e) && e.agentId).map((e) => e.agentId!))];
    const agentNodes: TreeNode[] = [];
    for (const agentId of agentIds) {
      const inAgent = (e: NormalizedEvent) => inTurn(e) && e.agentId === agentId;
      const tokens = tokensBy(inAgent);
      if (tokens === 0) continue;
      const aid = `${pid}/${agentId ?? 'main'}`;
      agentNodes.push({
        id: aid,
        label: agentId ? agentLabel(agentId) : 'main agent',
        kind: 'agent',
        tokens,
        turnId,
        agentId,
        shade,
        children: categoryChildren(aid, tokens, events.filter((e) => inAgent(e) && e.kind === 'tool_call'), shade),
      });
    }
    const badges = new Map<string, 'info' | 'warn'>();
    for (const f of findings) if (turnId && f.turnIds.includes(turnId)) badges.set(f.heuristicId, f.severity === 'warn' || badges.get(f.heuristicId) === 'warn' ? 'warn' : 'info');
    promptNodes.push({
      id: pid,
      label: turnId === undefined ? 'Unlinked' : `P${promptIndex.get(turnId)}`,
      kind: 'prompt',
      tokens: turnTokens,
      turnId,
      shade,
      findings: badges.size ? [...badges].map(([heuristicId, severity]) => ({ heuristicId, severity })) : undefined,
      children: agentNodes,
    });
  }
  const tree: TreeNode = {
    id: 's',
    label: `Session ${summary.sessionId.slice(0, 8)}`,
    kind: 'session',
    tokens: promptNodes.reduce((sum, n) => sum + n.tokens, 0),
    children: promptNodes,
  };

  return { summary, prompts, calls, compactions, subagents, marks: sessionMarks, findings, tree, categoryGroups: CATEGORY_COLOR_GROUPS.map((g) => g.label) };
}

/** Context sent by a timeline call (for tooltips and limit comparisons). */
export function callContext(c: TimelineCall): number {
  return contextSize({ tokens: { input: c.input, cacheRead: c.cacheRead, cacheCreation: c.cacheCreation } } as NormalizedEvent) ?? 0;
}
