import { AdvisorReport, formatMeasure } from '../advisor/report';

/**
 * `snagboat mcp` (RFC step 5d): an MCP server over stdio for the Claude Code
 * plugin, so an agent can read what Snagboat sees of the workspace it works
 * in: findings, sessions, one session's outcomes and findings, and the
 * advisors' measures. Read only: no tool writes anything, responds to a
 * finding or changes a setting. Every read goes to the core, which owns the
 * data (no front door is required, VS Code included).
 *
 * Newline-delimited JSON-RPC 2.0, as MCP's stdio transport specifies; no SDK,
 * since the four tools need only initialize, tools/list and tools/call.
 */

/** What the server reads, for one workspace (the one containing the folder Claude Code runs in). */
export interface McpReads {
  /** The workspace, or undefined when the core records none containing the folder. */
  workspace: string | undefined;
  get(path: string): Promise<{ status: number; body: unknown }>;
}

interface Tool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  run(args: Record<string, unknown>, reads: McpReads): Promise<string>;
}

const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const q = encodeURIComponent;

async function read<T>(reads: McpReads, path: string): Promise<T> {
  const res = await reads.get(path);
  if (res.status !== 200) throw new Error(`the core answered ${res.status}: ${(res.body as { error?: string })?.error ?? JSON.stringify(res.body)}`);
  return res.body as T;
}
const needWorkspace = (reads: McpReads): string => {
  if (!reads.workspace) throw new Error('Snagboat has no workspace containing this folder yet. It records one once Claude Code (or VS Code) works in it with the core running.');
  return reads.workspace;
};
const days = (args: Record<string, unknown>, fallback: number): number => {
  const n = Number(args.days ?? fallback);
  if (!Number.isInteger(n) || n < 1 || n > 90) throw new Error('days must be a whole number from 1 to 90');
  return n;
};
const compact = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e4 ? `${Math.round(n / 1e3)}k` : String(n));
const minutes = (from: string, to: string) => Math.max(0, Math.round((Date.parse(to) - Date.parse(from)) / 60_000));

interface SessionItem {
  sessionId: string;
  agent: string;
  name?: string;
  firstTs: string;
  lastTs: string;
  prompts: number;
  toolCalls: number;
  tokens: number;
  outcomes?: Record<string, number>;
}

export const TOOLS: Tool[] = [
  {
    name: 'snagboat_findings',
    description: "Snagboat's findings for this workspace now (heuristics such as stalled, tool churn, cache thrash, context pressure), with early warnings and whether you've already responded to each. Read only.",
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    async run(_args, reads) {
      const workspace = needWorkspace(reads);
      const [r] = await read<Array<{ findings: Array<{ heuristicId: string; severity: string; summary: string; suggestedAction?: string }>; progress: Array<{ heuristicId: string; share: number; summary: string }>; responses: Record<string, { acknowledged: boolean; useful: boolean; muted: boolean }> }>>(reads, `/findings?workspace=${q(workspace)}`);
      const lines = [
        ...r.findings.map((f) => {
          const st = r.responses[f.heuristicId];
          const met = st?.useful ? ' (marked useful)' : st?.acknowledged ? ' (acknowledged)' : '';
          return `${f.severity} ${f.heuristicId}: ${f.summary}${met}${f.suggestedAction ? `\n  suggested: ${f.suggestedAction}` : ''}`;
        }),
        ...r.progress.map((p) => `near ${p.heuristicId}: ${p.summary} (${Math.round(p.share * 100)}% of the way)`),
      ];
      return lines.length ? lines.join('\n') : 'No findings now.';
    },
  },
  {
    name: 'snagboat_sessions',
    description: "Agent sessions Snagboat recorded in this workspace, latest activity first: prompts, tool calls, tokens, and what came of each (tests going green, milestones, commits kept or reverted). Read only.",
    inputSchema: { type: 'object', properties: { days: { type: 'integer', minimum: 1, maximum: 90, description: 'Only sessions active in the last n days (default 7).' } }, additionalProperties: false },
    async run(args, reads) {
      const workspace = needWorkspace(reads);
      const list = await read<SessionItem[]>(reads, `/sessions?workspace=${q(workspace)}&days=${days(args, 7)}`);
      if (!list.length) return 'No sessions in that period.';
      return list
        .slice(0, 50)
        .map((s) => {
          const came = Object.entries(s.outcomes ?? {}).map(([k, n]) => `${k.replace(/_/g, ' ')}${n > 1 ? ` x${n}` : ''}`);
          return `${s.sessionId}  ${s.lastTs.slice(0, 16).replace('T', ' ')}Z  ${s.agent}  ${minutes(s.firstTs, s.lastTs)} min  ${s.prompts} prompts  ${s.toolCalls} tools  ${compact(s.tokens)} tokens${s.name ? `  "${s.name}"` : ''}${came.length ? `\n  came of it: ${came.join(', ')}` : ''}`;
        })
        .join('\n');
    },
  },
  {
    name: 'snagboat_session',
    description: "One session in this workspace by id or unique id prefix: its summary, its outcomes (tests green, milestones, commits and what became of them, how findings were met, approvals), and the findings it had. Read only.",
    inputSchema: { type: 'object', properties: { id: { type: 'string', description: 'The session id, or a unique prefix of it.' } }, required: ['id'], additionalProperties: false },
    async run(args, reads) {
      const workspace = needWorkspace(reads);
      const id = typeof args.id === 'string' ? args.id.trim() : '';
      if (!id) throw new Error('give the session id');
      const found = (await read<SessionItem[]>(reads, `/sessions?workspace=${q(workspace)}`)).filter((s) => s.sessionId === id || s.sessionId.startsWith(id));
      if (found.length !== 1) throw new Error(found.length ? `${id} matches ${found.length} sessions; give more of the id` : `no session ${id} in this workspace`);
      const page = await read<{ view: { summary: SessionItem & { models: string[] }; findings: Array<{ heuristicId: string; severity: string; summary: string; active: boolean; turnIds: string[] }> }; outcomes: Array<Record<string, unknown> & { type: string; ts: string }> }>(reads, `/sessions/${q(found[0].sessionId)}/view?workspace=${q(workspace)}`);
      const s = page.view.summary;
      const lines = [
        `${s.sessionId}${s.name ? ` "${s.name}"` : ''}: ${s.agent}, ${s.models.join(', ') || 'no model recorded'}, ${s.firstTs} to ${s.lastTs} (${minutes(s.firstTs, s.lastTs)} min), ${s.prompts} prompts, ${s.toolCalls} tool calls, ${compact(s.tokens)} tokens`,
        'Outcomes:',
        ...(page.outcomes.length ? page.outcomes.map((o) => `  ${o.ts.slice(0, 16).replace('T', ' ')}Z ${o.type.replace(/_/g, ' ')} ${outcomeText(o)}`.trimEnd()) : ['  none recorded']),
        'Findings:',
        ...(page.view.findings.length ? page.view.findings.map((f) => `  ${f.severity} ${f.heuristicId}: ${f.summary}${f.active ? ' (reporting now)' : ''}`) : ['  none']),
      ];
      return lines.join('\n');
    },
  },
  {
    name: 'snagboat_advisors',
    description: "Snagboat's advisors (Purser: token cost; Navigator: time and pace; Bosun: risky commands; Lookout: interruptions; plus any you added): each one's goal, its measures this period against the one before, and its brief on this workspace. Read only.",
    inputSchema: { type: 'object', properties: { days: { type: 'integer', minimum: 1, maximum: 90, description: 'The period measured, against the same length before it (default 7).' } }, additionalProperties: false },
    async run(args, reads) {
      const workspace = needWorkspace(reads);
      const n = days(args, 7);
      const r = await read<{ advisors: AdvisorReport[] }>(reads, `/advisors?workspace=${q(workspace)}&days=${n}`);
      return r.advisors
        .map((a) => {
          const measures = a.measures.map((m) => {
            const was = m.previous !== undefined ? `, was ${formatMeasure(m.previous, m.unit)}` : '';
            return `  ${m.label}: ${formatMeasure(m.value, m.unit)}${was}${m.trend && m.trend !== 'same' ? ` (${m.trend})` : ''}${m.note ? ` (${m.note})` : ''}`;
          });
          const b = a.brief;
          const brief = b ? [`  brief: ${b.summary}`, ...(b.watching ? [`  watching: ${b.watching}`] : []), ...(b.surface.kind !== 'none' ? [`  to surface (${b.surface.label}): ${b.surface.finding ? `${b.surface.finding.heuristicId}: ${b.surface.finding.summary}` : b.surface.text}`] : [])] : [];
          return [`${a.name} — ${a.status} (goal ${a.goal}), last ${n} days against the ${n} before:`, ...measures, ...brief].join('\n');
        })
        .join('\n\n');
    },
  },
];

function outcomeText(o: Record<string, unknown>): string {
  switch (o.type) {
    case 'tests_green':
      return `after ${o.failures ?? 0} failed run(s)${typeof o.afterMs === 'number' ? `, ${Math.round(o.afterMs / 60_000)} min` : ''}`;
    case 'milestone':
    case 'commit_kept':
    case 'commit_reverted':
      return `${String(o.commit ?? '').slice(0, 7)}${o.days ? ` at ${o.days} days` : ''}`;
    case 'code_survival':
      return `${o.linesSurviving} of ${o.linesWritten} lines at ${o.days} days`;
    case 'finding_response':
      return `${o.heuristicId}: ${o.response}`;
    case 'notified':
      return `${o.heuristicId ?? ''}${o.advisor ? ` (${o.advisor})` : ''}`;
    case 'approval':
      return String(o.decision ?? '');
    default:
      return '';
  }
}

interface Request {
  jsonrpc: '2.0';
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

/** Answers one JSON-RPC message; undefined for notifications (no id). */
export async function handleMcp(message: unknown, reads: () => Promise<McpReads>, version: string): Promise<Record<string, unknown> | undefined> {
  const m = message as Partial<Request>;
  if (!m || typeof m !== 'object' || m.jsonrpc !== '2.0' || typeof m.method !== 'string') {
    return { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'invalid request' } };
  }
  const isNotification = m.id === undefined;
  const reply = (result: unknown) => (isNotification ? undefined : { jsonrpc: '2.0', id: m.id, result });
  const fail = (code: number, msg: string) => (isNotification ? undefined : { jsonrpc: '2.0', id: m.id, error: { code, message: msg } });
  switch (m.method) {
    case 'initialize': {
      const asked = typeof m.params?.protocolVersion === 'string' ? m.params.protocolVersion : '';
      return reply({
        protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
        capabilities: { tools: {} },
        serverInfo: { name: 'snagboat', version },
        instructions: "Snagboat records this workspace's coding-agent sessions and works out findings, outcomes and advisors' measures. These tools read them; none changes anything.",
      });
    }
    case 'ping':
      return reply({});
    case 'tools/list':
      return reply({ tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema, annotations: { readOnlyHint: true, openWorldHint: false } })) });
    case 'tools/call': {
      const tool = TOOLS.find((t) => t.name === m.params?.name);
      if (!tool) return fail(-32602, `no such tool: ${String(m.params?.name)}`);
      const args = (m.params?.arguments && typeof m.params.arguments === 'object' ? m.params.arguments : {}) as Record<string, unknown>;
      try {
        return reply({ content: [{ type: 'text', text: await tool.run(args, await reads()) }] });
      } catch (err) {
        return reply({ content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }], isError: true });
      }
    }
    default:
      if (m.method.startsWith('notifications/')) return undefined;
      return fail(-32601, `method not found: ${m.method}`);
  }
}

/** Runs the server over a line stream: one JSON-RPC message per line in, one per line out. */
export function serveMcp(input: NodeJS.ReadableStream, write: (line: string) => void, reads: () => Promise<McpReads>, version: string): Promise<void> {
  return new Promise((resolve) => {
    let buffer = '';
    let pending = Promise.resolve();
    input.setEncoding?.('utf8');
    input.on('data', (chunk: string) => {
      buffer += chunk;
      let nl: number;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        // In order: each answer is written before the next request is handled.
        pending = pending.then(async () => {
          let message: unknown;
          try {
            message = JSON.parse(line);
          } catch {
            write(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }));
            return;
          }
          const out = await handleMcp(message, reads, version);
          if (out) write(JSON.stringify(out));
        });
      }
    });
    input.on('end', () => void pending.then(resolve));
  });
}
