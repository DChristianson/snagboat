import { classifyTool, EventRefs, EventToolInput, isShellTool } from '@snagboat/schema';
import { cutAt, redactSecrets } from './excerpt';

/**
 * What a tool call's event records of its input (schema v4 `toolInput`) and
 * what it observably acted on (`refs`), for every adapter that sees a call's
 * arguments (Claude Code's hooks and transcripts, the Copilot CLI's session
 * log). See docs/schema.md's transformation matrix.
 */

/** The most of one toolInput field that's stored (a heredoc'd commit message, say), in UTF-16 code units. */
export const TOOL_INPUT_MAX_CHARS = 2000;

/** Tools whose input is plan state that todos and taskOp already record (a task's description is never kept). */
const PLAN_TOOLS = new Set(['TodoWrite', 'TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet']);

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v : undefined);

/** One field's value: secrets redacted over the whole text, then cut to TOOL_INPUT_MAX_CHARS with an ellipsis. */
function field(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const text = redactSecrets(value.trim());
  if (!text) return undefined;
  return text.length <= TOOL_INPUT_MAX_CHARS ? text : `${cutAt(text, TOOL_INPUT_MAX_CHARS - 1)}…`;
}

/**
 * The parts of a tool call's input worth drawing, by the argument names the
 * agents use: the path (`file_path`, `notebook_path`, `path`, `filePath`)
 * always, as `target` keeps it; the command (shell tools only), the search
 * pattern (`pattern`, or a search's `query`), the URL (`url`) and the call's
 * description (shell and subagent tools only) only with captureContent. Each
 * redacted and capped. Never the tool's output, and nothing for the plan
 * tools, whose todos and taskOp say what matters. Undefined when there's none.
 */
export function toolInputOf(toolName: string | undefined, input: unknown, captureContent: boolean): EventToolInput | undefined {
  if (typeof input !== 'object' || input === null || Array.isArray(input) || (toolName !== undefined && PLAN_TOOLS.has(toolName))) return undefined;
  const inp = input as Record<string, unknown>;
  const out: EventToolInput = {};
  const shell = isShellTool(toolName);
  const path = field(str(inp.file_path) ?? str(inp.notebook_path) ?? str(inp.path) ?? str(inp.filePath));
  if (path) out.path = path;
  if (captureContent) {
    const command = shell ? field(str(inp.command)) : undefined;
    if (command) out.command = command;
    const pattern = field(str(inp.pattern) ?? str(inp.query));
    if (pattern) out.pattern = pattern;
    const url = field(str(inp.url));
    if (url) out.url = url;
    const description = shell || classifyTool(toolName) === 'subagent' ? field(str(inp.description)) : undefined;
    if (description) out.description = description;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

// ---- refs ---------------------------------------------------------------

/**
 * A command line's simple commands, as word lists, in order: split at `;`,
 * `&`, `|`, `&&`, `||`, newlines and parentheses, quotes and backslashes
 * resolved, comments dropped. Heredoc bodies, and command substitutions
 * (`$(...)`, backticks) are opaque: kept as text inside the word they're in,
 * never read as commands, so `git commit -m "$(cat <<'EOF' ... EOF)"` is one
 * command whatever the message says. Not a shell parser: just enough to find
 * the commands a line plainly runs.
 */
export function shellCommands(command: string): string[][] {
  const s = command;
  const n = s.length;
  const commands: string[][] = [];
  let words: string[] = [];
  let word = '';
  let inWord = false;
  const heredocs: Array<{ delimiter: string; tabs: boolean }> = [];
  const endWord = () => {
    if (inWord) words.push(word);
    word = '';
    inWord = false;
  };
  const endCommand = () => {
    endWord();
    if (words.length > 0) commands.push(words);
    words = [];
  };
  let i = 0;
  while (i < n) {
    const c = s[i];
    if (c === "'") {
      const j = s.indexOf("'", i + 1);
      const end = j < 0 ? n : j;
      word += s.slice(i + 1, end);
      inWord = true;
      i = end + 1;
    } else if (c === '"') {
      const r = readDouble(s, i + 1);
      word += r.text;
      inWord = true;
      i = r.end;
    } else if (c === '\\') {
      if (s[i + 1] !== '\n') {
        word += s[i + 1] ?? '';
        inWord = true;
      }
      i += 2;
    } else if (c === '$' && s[i + 1] === '(') {
      const end = skipSubstitution(s, i + 2);
      word += s.slice(i, end);
      inWord = true;
      i = end;
    } else if (c === '`') {
      const end = skipBackticks(s, i + 1);
      word += s.slice(i, end);
      inWord = true;
      i = end;
    } else if (c === '#' && !inWord) {
      while (i < n && s[i] !== '\n') i++;
    } else if (c === '\n') {
      endCommand();
      i = skipHeredocBodies(s, i + 1, heredocs);
    } else if (c === ' ' || c === '\t' || c === '\r') {
      endWord();
      i++;
    } else if (c === ';' || c === '&' || c === '|' || c === '(' || c === ')' || (c === '{' && !inWord)) {
      endCommand();
      i++;
    } else if (c === '<' && s[i + 1] === '<' && s[i + 2] !== '<') {
      endWord();
      const r = readHeredocDelimiter(s, i + 2);
      if (r.delimiter) heredocs.push({ delimiter: r.delimiter, tabs: r.tabs });
      i = r.end;
    } else {
      word += c;
      inWord = true;
      i++;
    }
  }
  endCommand();
  return commands;
}

/** A double-quoted string's text from just after its opening quote: [text, the index after its closing quote]. */
function readDouble(s: string, start: number): { text: string; end: number } {
  let text = '';
  let i = start;
  while (i < s.length) {
    const c = s[i];
    if (c === '"') return { text, end: i + 1 };
    if (c === '\\') {
      const next = s[i + 1] ?? '';
      text += '$`"\\\n'.includes(next) ? (next === '\n' ? '' : next) : c + next;
      i += 2;
    } else if (c === '$' && s[i + 1] === '(') {
      const end = skipSubstitution(s, i + 2);
      text += s.slice(i, end);
      i = end;
    } else if (c === '`') {
      const end = skipBackticks(s, i + 1);
      text += s.slice(i, end);
      i = end;
    } else {
      text += c;
      i++;
    }
  }
  return { text, end: s.length };
}

/** The index after a `$(...)` whose contents start at `start`: nested quotes, parentheses and heredocs skipped. */
function skipSubstitution(s: string, start: number): number {
  let depth = 1;
  let i = start;
  const heredocs: Array<{ delimiter: string; tabs: boolean }> = [];
  while (i < s.length) {
    const c = s[i];
    if (c === "'") {
      const j = s.indexOf("'", i + 1);
      i = j < 0 ? s.length : j + 1;
    } else if (c === '"') {
      i = readDouble(s, i + 1).end;
    } else if (c === '\\') {
      i += 2;
    } else if (c === '`') {
      i = skipBackticks(s, i + 1);
    } else if (c === '$' && s[i + 1] === '(') {
      i = skipSubstitution(s, i + 2);
    } else if (c === '(') {
      depth++;
      i++;
    } else if (c === ')') {
      depth--;
      i++;
      if (depth === 0) return i;
    } else if (c === '<' && s[i + 1] === '<' && s[i + 2] !== '<') {
      const r = readHeredocDelimiter(s, i + 2);
      if (r.delimiter) heredocs.push({ delimiter: r.delimiter, tabs: r.tabs });
      i = r.end;
    } else if (c === '\n') {
      i = skipHeredocBodies(s, i + 1, heredocs);
    } else {
      i++;
    }
  }
  return s.length;
}

function skipBackticks(s: string, start: number): number {
  let i = start;
  while (i < s.length) {
    if (s[i] === '\\') i += 2;
    else if (s[i] === '`') return i + 1;
    else i++;
  }
  return s.length;
}

/** After `<<`: the heredoc's delimiter (quotes removed) and whether it's `<<-`, and the index after it. */
function readHeredocDelimiter(s: string, start: number): { delimiter: string; tabs: boolean; end: number } {
  let i = start;
  const tabs = s[i] === '-';
  if (tabs) i++;
  while (s[i] === ' ' || s[i] === '\t') i++;
  let delimiter = '';
  while (i < s.length && !' \t\n;&|()<>'.includes(s[i])) {
    if (s[i] !== "'" && s[i] !== '"' && s[i] !== '\\') delimiter += s[i];
    i++;
  }
  return { delimiter, tabs, end: i };
}

/** From the start of a line: past the bodies of the heredocs waiting for one (each up to its delimiter line). */
function skipHeredocBodies(s: string, start: number, heredocs: Array<{ delimiter: string; tabs: boolean }>): number {
  let i = start;
  while (heredocs.length > 0 && i < s.length) {
    const { delimiter, tabs } = heredocs[0];
    const eol = s.indexOf('\n', i);
    const lineEnd = eol < 0 ? s.length : eol;
    let line = s.slice(i, lineEnd).replace(/\r$/, '');
    if (tabs) line = line.replace(/^\t+/, '');
    i = lineEnd + 1;
    if (line === delimiter) heredocs.shift();
  }
  heredocs.length = 0;
  return Math.min(i, s.length);
}

/** Words that only run the command after them. */
const WRAPPERS = new Set(['sudo', 'env', 'command', 'exec', 'time', 'nohup', 'nice']);

/** A command's words from the program on: leading VAR=value assignments and wrappers (sudo, env, time) dropped. */
function programWords(words: string[]): string[] {
  let i = 0;
  while (i < words.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i]) || WRAPPERS.has(words[i]))) i++;
  return words.slice(i);
}

const program = (word: string | undefined) => word?.split('/').pop();

/** A name git would take as a branch: no spaces, `..`, leading dash, `@{`, or trailing `.lock`/`/`/`.`. */
export function isBranchName(name: string | undefined): name is string {
  return (
    !!name &&
    name.length <= 255 &&
    /^[A-Za-z0-9._/+-]+$/.test(name) &&
    !name.startsWith('-') &&
    !name.startsWith('/') &&
    !name.includes('..') &&
    !name.includes('//') &&
    !/(\.lock|\/|\.)$/.test(name) &&
    name !== 'HEAD'
  );
}

/** A bead id: a prefix, a hyphen and a short hash, with `.N` for each child level (snagboat-koh, snagboat-93b.10.2). */
export function isPlanItemId(id: string | undefined): id is string {
  return !!id && id.length <= 100 && /^[A-Za-z][A-Za-z0-9_]*(?:-[A-Za-z0-9_]+)*-[a-z0-9]{2,}(?:\.\d+)*$/.test(id);
}

const isSha = (s: string | undefined): s is string => !!s && /^[0-9a-f]{7,40}$/.test(s);

/** The options and positional arguments of a command, given which options take a value (`--x=y` carries its own). */
function splitArgs(args: string[], valued: ReadonlySet<string>): { options: Map<string, string | true>; positional: string[] } {
  const options = new Map<string, string | true>();
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--') {
      positional.push(...args.slice(i + 1));
      break;
    }
    if (a.startsWith('-') && a.length > 1) {
      const eq = a.startsWith('--') ? a.indexOf('=') : -1;
      if (eq > 0) options.set(a.slice(0, eq), a.slice(eq + 1));
      else if (valued.has(a)) options.set(a, args[++i] ?? '');
      else options.set(a, true);
    } else positional.push(a);
  }
  return { options, positional };
}

const optionValue = (options: Map<string, string | true>, ...names: string[]): string | undefined => {
  for (const name of names) {
    const v = options.get(name);
    if (typeof v === 'string') return v;
  }
  return undefined;
};

/** git's options before its subcommand that take a value. */
const GIT_GLOBAL_VALUED = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path', '--config-env']);
const GIT_CHECKOUT_VALUED = new Set(['-b', '-B', '--orphan', '--conflict', '--pathspec-from-file']);
const GIT_SWITCH_VALUED = new Set(['-c', '-C', '--create', '--force-create', '--orphan', '--conflict']);
const GIT_WORKTREE_ADD_VALUED = new Set(['-b', '-B', '--reason']);
const GH_PR_MERGE_VALUED = new Set(['-t', '--subject', '-b', '--body', '-F', '--body-file', '-A', '--author-email', '--match-head-commit', '-R', '--repo']);
/** bd's options that take a value (any other option is read as a flag). */
const BD_VALUED = new Set([
  '--db', '--actor', '--dir',
  '--title', '--description', '-d', '--notes', '--append-notes', '--design', '--acceptance', '--status', '-s', '--priority', '-p',
  '--assignee', '-a', '--reason', '-r', '--type', '-t', '--labels', '-l', '--label', '--add-label', '--remove-label', '--set-labels',
  '--parent', '--deps', '--external-ref', '--estimate', '-e', '--body-file', '--file', '-f', '--due', '--defer', '--session', '--id',
  '--title-file', '--description-file', '--format', '--author',
]);
/** bd subcommands whose positional arguments are the plan items they act on. */
const BD_ITEM_COMMANDS = new Set(['show', 'update', 'close', 'reopen', 'claim', 'comment', 'comments', 'dep', 'label', 'defer', 'undefer']);

interface CommandRefs {
  commit?: string;
  branch?: string;
  planItems: string[];
  /** Which commands ran, so the output is only read for what they print. */
  ran: { commit: boolean; checkout: boolean; worktree: boolean; prMerge: boolean; bdCreate: boolean; bdJson: boolean };
}

/** What a command line's own words show it acting on. */
function commandRefs(command: string): CommandRefs {
  const refs: CommandRefs = { planItems: [], ran: { commit: false, checkout: false, worktree: false, prMerge: false, bdCreate: false, bdJson: false } };
  for (const all of shellCommands(command)) {
    const words = programWords(all);
    const name = program(words[0]);
    if (name === 'git') {
      let i = 1;
      while (i < words.length && words[i].startsWith('-')) i += GIT_GLOBAL_VALUED.has(words[i]) ? 2 : 1;
      const sub = words[i];
      const args = words.slice(i + 1);
      if (sub === 'commit') refs.ran.commit = true;
      else if (sub === 'checkout') {
        refs.ran.checkout = true;
        // A bare `git checkout <name>` may restore a file of that name, so only -b, -B and --orphan name a branch here.
        const { options } = splitArgs(args, GIT_CHECKOUT_VALUED);
        const branch = optionValue(options, '-b', '-B', '--orphan');
        if (isBranchName(branch)) refs.branch = branch;
      } else if (sub === 'switch') {
        refs.ran.checkout = true;
        const { options, positional } = splitArgs(args, GIT_SWITCH_VALUED);
        const created = optionValue(options, '-c', '-C', '--create', '--force-create', '--orphan');
        const branch = created ?? (options.has('--detach') || options.has('-d') ? undefined : positional[0]);
        if (isBranchName(branch)) refs.branch = branch;
      } else if (sub === 'worktree' && args[0] === 'add') {
        refs.ran.worktree = true;
        const { options } = splitArgs(args.slice(1), GIT_WORKTREE_ADD_VALUED);
        const branch = optionValue(options, '-b', '-B');
        if (isBranchName(branch)) refs.branch = branch;
      }
    } else if (name === 'gh' && words[1] === 'pr' && words[2] === 'merge') {
      refs.ran.prMerge = true;
      const { options, positional } = splitArgs(words.slice(3), GH_PR_MERGE_VALUED);
      const head = optionValue(options, '--match-head-commit');
      if (isSha(head)) refs.commit = head;
      // The PR by branch name; a number or URL names no branch, and none at all means the current branch, which the line doesn't show.
      const pr = positional[0];
      if (pr && !/^#?\d+$/.test(pr) && !/^https?:/.test(pr) && isBranchName(pr)) refs.branch = pr;
    } else if (name === 'bd') {
      let i = 1;
      while (i < words.length && words[i].startsWith('-')) i += BD_VALUED.has(words[i]) ? 2 : 1;
      const sub = words[i];
      const { options, positional } = splitArgs(words.slice(i + 1), BD_VALUED);
      if (options.has('--json')) refs.ran.bdJson = true;
      if (sub === 'create' || sub === 'new' || sub === 'q') refs.ran.bdCreate = true;
      else if (sub && BD_ITEM_COMMANDS.has(sub)) {
        for (const id of positional) if (isPlanItemId(id) && !refs.planItems.includes(id)) refs.planItems.push(id);
      }
    }
  }
  return refs;
}

/** One bd command in a command line: its subcommand, the plan items its words name, and whether it claims them. */
export interface BdAction {
  /** The subcommand as typed (create, update, close, show, ...). */
  sub: string;
  /** The bead ids among its positional arguments (none for create: the id is in its output). */
  items: string[];
  /** `bd update --claim`, or `bd claim`. */
  claim: boolean;
  /** `--status <s>`, when given. */
  status?: string;
}

/** What a command line runs that the linker reads (links.ts): git's commit, checkout, switch and worktree add, gh pr merge, and each bd command. */
export interface CommandActions {
  gitCommit: boolean;
  checkout: boolean;
  prMerge: boolean;
  bd: BdAction[];
}

/** The git, gh and bd commands a command line plainly runs (shellCommands' reading of it). */
export function commandActions(command: string): CommandActions {
  const refs = commandRefs(command);
  const out: CommandActions = { gitCommit: refs.ran.commit, checkout: refs.ran.checkout || refs.ran.worktree, prMerge: refs.ran.prMerge, bd: [] };
  for (const all of shellCommands(command)) {
    const words = programWords(all);
    if (program(words[0]) !== 'bd') continue;
    let i = 1;
    while (i < words.length && words[i].startsWith('-')) i += BD_VALUED.has(words[i]) ? 2 : 1;
    const sub = words[i];
    if (!sub) continue;
    const { options, positional } = splitArgs(words.slice(i + 1), BD_VALUED);
    const items = BD_ITEM_COMMANDS.has(sub) ? positional.filter((id) => isPlanItemId(id)) : [];
    const status = optionValue(options, '--status', '-s');
    out.bd.push({ sub, items: [...new Set(items)], claim: sub === 'claim' || options.has('--claim'), ...(status ? { status } : {}) });
  }
  return out;
}

/** A tool's output as text: a string, text content blocks, or a shell result's stdout and stderr. The first 64 KB. */
export function toolOutputText(output: unknown): string {
  let text = '';
  if (typeof output === 'string') text = output;
  else if (Array.isArray(output)) text = output.map((b) => (typeof b === 'string' ? b : typeof b?.text === 'string' ? b.text : '')).join('\n');
  else if (typeof output === 'object' && output !== null) {
    const o = output as Record<string, unknown>;
    text = [o.stdout, o.stderr, o.output, o.error].filter((v): v is string => typeof v === 'string').join('\n');
    if (!text && o.content !== undefined) text = toolOutputText(o.content);
  }
  return text.length > 65_536 ? text.slice(0, 65_536) : text;
}

const lastMatch = (text: string, pattern: RegExp): RegExpExecArray | undefined => {
  let last: RegExpExecArray | undefined;
  for (const m of text.matchAll(pattern)) last = m as RegExpExecArray;
  return last;
};

/**
 * What a shell tool call observably acted on (schema v4 `refs`), from its
 * command line and, where the adapter has it, its output:
 * - `git commit`: the commit's SHA, only from the summary line git prints
 *   (`[main 1a2b3c4] subject`), since the command doesn't show it; with no
 *   output (or none recognized), nothing.
 * - `git checkout -b/-B/--orphan <branch>`, `git switch [-c] <branch>`,
 *   `git worktree add -b <branch>`: that branch; or the one git says it
 *   switched to (`Switched to branch 'x'`, `Preparing worktree (new branch
 *   'x')`), which also covers a bare `git checkout x`, otherwise skipped as
 *   it may be restoring a file.
 * - `gh pr merge <branch>`: that branch (a PR number or URL names none), or
 *   the one gh says it deleted; `--match-head-commit <sha>`: that commit.
 * - `bd show|update|close|reopen|claim|comment(s)|dep|label|defer <id>...`:
 *   those ids; `bd create`: the id it printed (`Created issue: x`, or the
 *   first `"id"` of its --json output).
 * What the words show counts only for a call that didn't fail; what the output
 * shows counts either way (a chain can commit, then fail to push). A chain's
 * last branch wins; plan items are kept in order. Undefined when there's none.
 */
export function refsOf(toolName: string | undefined, input: unknown, output: unknown, failed: boolean): EventRefs | undefined {
  if (!isShellTool(toolName)) return undefined;
  const command = str((input as { command?: unknown } | undefined)?.command);
  if (!command) return undefined;
  const words = commandRefs(command);
  const text = output === undefined ? '' : toolOutputText(output);
  const refs: EventRefs = {};
  if (!failed) {
    if (words.commit) refs.commit = words.commit;
    if (words.branch) refs.branch = words.branch;
  }
  const items = failed ? [] : [...words.planItems];
  if (text) {
    if (words.ran.commit) {
      const m = lastMatch(text, /^\[(.+?)(?: \(root-commit\))? ([0-9a-f]{7,40})\] /gm);
      if (m) refs.commit = m[2];
    }
    if (words.ran.checkout) {
      const m = lastMatch(text, /Switched to (?:a new |and reset )?branch '([^'\n]+)'/g);
      if (m && isBranchName(m[1])) refs.branch = m[1];
    }
    if (words.ran.worktree) {
      const m = lastMatch(text, /Preparing worktree \((?:new branch|checking out|resetting branch) '([^'\n]+)'\)/g);
      if (m && isBranchName(m[1])) refs.branch = m[1];
    }
    if (words.ran.prMerge && !refs.branch) {
      const m = lastMatch(text, /Deleted (?:local |remote )?branch ([^\s,]+)/g);
      if (m && isBranchName(m[1])) refs.branch = m[1];
    }
    if (words.ran.bdCreate) {
      const created = [...text.matchAll(/Created issue:?\s+([^\s:,]+)/g)].map((m) => m[1]);
      const json = words.ran.bdJson ? /"id"\s*:\s*"([^"]+)"/.exec(text) : null;
      if (json) created.push(json[1]);
      for (const id of created) if (isPlanItemId(id) && !items.includes(id)) items.push(id);
    }
  }
  if (items.length > 0) refs.planItems = items;
  return Object.keys(refs).length > 0 ? refs : undefined;
}
