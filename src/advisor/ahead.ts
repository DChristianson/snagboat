import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import type { EventTaskOp, EventTodos, NormalizedEvent, TodoStatus } from '@snagboat/schema';

/**
 * Navigator's "Ahead" line (RFC step 5a, the design pass): the work still to
 * do. Beads first: the workspace's Beads issues when it has a .beads folder and
 * `bd` is installed. Read only: every command runs with --readonly (writes
 * blocked) and --sandbox (no Dolt auto-push), and Navigator never closes or
 * edits a bead. Plan as fallback: without Beads, the todo list the agent keeps
 * in its session (Claude Code's TodoWrite calls, or its task tools, as
 * recorded). With neither, the line is left out.
 */

export interface Bead {
  id: string;
  title: string;
}

export interface BeadsAhead {
  source: 'beads';
  /** Issues being worked on now. */
  inProgress: Bead[];
  /** The next ready issue (not an epic), highest priority first. */
  next?: Bead;
  /** Issues waiting on others, and what the first waits on. */
  blocked: number;
  firstBlocked?: Bead & { blockedBy: string[] };
  /** Issues closed in the last 7 days: the pace. */
  closedThisWeek: number;
}

/** The work ahead from a session's todo list (its latest TodoWrite call, or what its task tool calls left). */
export interface PlanAhead {
  source: 'plan';
  sessionId: string;
  /** The session's name, when one was recorded. */
  sessionName?: string;
  /** The session was active in the last LIVE_MS. */
  live: boolean;
  /** Whether the items' text was captured (snagboat.captureContent); without it, only counts. */
  text: boolean;
  /** Items in progress, by their text (up to 3; empty without text). */
  inProgress: string[];
  /** The first pending item's text. */
  next?: string;
  pending: number;
  inProgressCount: number;
  completed: number;
}

export type Ahead = BeadsAhead | PlanAhead;

/** A session counts as live when it did something in the last 15 minutes. */
export const LIVE_MS = 15 * 60_000;

export type BdRunner = (args: string[], cwd: string) => Promise<string>;

export const runBd: BdRunner = (args, cwd) =>
  new Promise((resolve, reject) => {
    execFile('bd', ['--readonly', '--sandbox', ...args], { cwd, timeout: 8_000, maxBuffer: 8 * 1024 * 1024, windowsHide: true }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
  });

interface Issue {
  id: string;
  title: string;
  issue_type?: string;
  priority?: number;
  closed_at?: string;
  blocked_by?: string[];
}

const parse = (text: string): Issue[] => {
  const v = JSON.parse(text) as unknown;
  return Array.isArray(v) ? (v as Issue[]) : [];
};
const bead = (i: Issue): Bead => ({ id: i.id, title: i.title });

/** What's ahead in this folder's Beads, or undefined when it has none (or bd isn't installed, or fails). */
export async function beadsAhead(folder: string, now = Date.now(), bd: BdRunner = runBd): Promise<BeadsAhead | undefined> {
  if (!fs.existsSync(path.join(folder, '.beads'))) return undefined;
  try {
    const [ready, blocked, inProgress, closed] = await Promise.all([
      bd(['ready', '--json'], folder).then(parse),
      bd(['blocked', '--json'], folder).then(parse),
      bd(['list', '--status=in_progress', '--json'], folder).then(parse),
      bd(['list', '--status=closed', '--json'], folder).then(parse),
    ]);
    const tasks = ready.filter((i) => i.issue_type !== 'epic').sort((a, b) => (a.priority ?? 9) - (b.priority ?? 9));
    const weekAgo = new Date(now - 7 * 86_400_000).toISOString();
    return {
      source: 'beads',
      inProgress: inProgress.filter((i) => i.issue_type !== 'epic').slice(0, 3).map(bead),
      ...(tasks[0] ? { next: bead(tasks[0]) } : {}),
      blocked: blocked.length,
      ...(blocked[0] ? { firstBlocked: { ...bead(blocked[0]), blockedBy: blocked[0].blocked_by ?? [] } } : {}),
      closedThisWeek: closed.filter((i) => (i.closed_at ?? '') >= weekAgo).length,
    };
  } catch {
    return undefined;
  }
}

/**
 * The task list a session's task tool calls (TaskCreate, TaskUpdate,
 * TaskList) leave, replayed in order: a create adds a pending task, an update
 * sets its status or subject (deleted removes it; one for a task not seen yet
 * adds it, as its create may not have been recorded), and a list replaces
 * everything with what it shows. In the same shape as a TodoWrite list: items
 * (in the order the tasks were made) only when some subject was captured.
 */
export function replayTasks(ops: EventTaskOp[]): EventTodos {
  const tasks = new Map<string, { status: TodoStatus; subject?: string }>();
  for (const op of ops) {
    if (op.op === 'list') {
      tasks.clear();
      for (const t of op.tasks ?? []) tasks.set(t.id, { status: t.status, ...(t.subject ? { subject: t.subject } : {}) });
      continue;
    }
    if (!op.id) continue;
    const task = tasks.get(op.id);
    if (op.status === 'deleted') {
      tasks.delete(op.id);
      continue;
    }
    const next = { status: (op.op === 'update' ? op.status : undefined) ?? task?.status ?? 'pending', subject: op.subject ?? task?.subject };
    tasks.set(op.id, next.subject ? next : { status: next.status });
  }
  const todos: EventTodos = { pending: 0, inProgress: 0, completed: 0 };
  const items: NonNullable<EventTodos['items']> = [];
  for (const t of tasks.values()) {
    if (t.status === 'pending') todos.pending += 1;
    else if (t.status === 'in_progress') todos.inProgress += 1;
    else todos.completed += 1;
    if (t.subject) items.push({ text: t.subject, status: t.status });
  }
  if (items.length) todos.items = items;
  return todos;
}

/**
 * What's ahead in the agent's own plan: the todo list from the workspace's
 * most recent session that has one, a live session first. A session's list is
 * its latest TodoWrite call's, or what its task tool calls left, whichever it
 * used last. Its in-progress items, the next pending one and how many are
 * done; counts only when the items' text wasn't captured. Undefined when no
 * session has a todo list.
 */
export function planAhead(events: NormalizedEvent[], now = Date.now()): PlanAhead | undefined {
  const lastActive = new Map<string, number>();
  const lastList = new Map<string, NormalizedEvent>();
  const taskOps = new Map<string, NormalizedEvent[]>();
  const names = new Map<string, string>();
  for (const e of events) {
    const at = Date.parse(e.ts);
    if (Number.isNaN(at)) continue;
    if (e.kind === 'session_name') {
      if (e.sessionName) names.set(e.sessionId, e.sessionName);
      continue;
    }
    if (e.kind === 'outcome') continue; // not agent activity
    if (at > (lastActive.get(e.sessionId) ?? -Infinity)) lastActive.set(e.sessionId, at);
    if (e.kind !== 'tool_call') continue;
    if (e.todos) {
      const prev = lastList.get(e.sessionId);
      if (!prev || e.ts >= prev.ts) lastList.set(e.sessionId, e);
    }
    if (e.taskOp) {
      const ops = taskOps.get(e.sessionId) ?? [];
      ops.push(e);
      taskOps.set(e.sessionId, ops);
    }
  }
  const live = (id: string) => now - (lastActive.get(id) ?? -Infinity) <= LIVE_MS;
  const withPlan = new Set([...lastList.keys(), ...taskOps.keys()]);
  const [sessionId] = [...withPlan].sort((a, b) => Number(live(b)) - Number(live(a)) || (lastActive.get(b) ?? 0) - (lastActive.get(a) ?? 0));
  if (sessionId === undefined) return undefined;
  // The task tools change the list a call at a time, so their calls are replayed in order (a stable sort keeps the log's order for ties).
  const ops = (taskOps.get(sessionId) ?? []).slice().sort((a, b) => a.ts.localeCompare(b.ts));
  const list = lastList.get(sessionId);
  const lastOp = ops[ops.length - 1];
  const todos = lastOp && (!list || lastOp.ts >= list.ts) ? replayTasks(ops.map((e) => e.taskOp!)) : list!.todos!;
  const items = todos.items;
  const name = names.get(sessionId);
  return {
    source: 'plan',
    sessionId,
    ...(name ? { sessionName: name } : {}),
    live: live(sessionId),
    text: items !== undefined,
    inProgress: (items ?? []).filter((i) => i.status === 'in_progress').slice(0, 3).map((i) => i.text),
    ...(items?.find((i) => i.status === 'pending') ? { next: items.find((i) => i.status === 'pending')!.text } : {}),
    pending: todos.pending,
    inProgressCount: todos.inProgress,
    completed: todos.completed,
  };
}

/**
 * Navigator's Ahead line for a workspace: its Beads when the folder has them
 * (and bd answers), else the plan from its sessions' events, else nothing.
 */
export async function navigatorAhead(folder: string | undefined, events: NormalizedEvent[], now = Date.now(), bd: BdRunner = runBd): Promise<Ahead | undefined> {
  return (folder ? await beadsAhead(folder, now, bd) : undefined) ?? planAhead(events, now);
}
