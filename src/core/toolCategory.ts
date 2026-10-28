/**
 * High-level classification of tool calls: what kind of thing an agent ran.
 * Deliberately simple pattern matching on the tool's name and, for shell
 * commands, the first meaningful words of the command line. It will mislabel
 * some calls (a `make` target that deploys, a script run through `npm run`);
 * that's acceptable for an overview. See docs/design/conversation-view.md.
 */
export type ToolCategory =
  | 'file-read'
  | 'file-edit'
  | 'search'
  | 'script'
  | 'tests-builds'
  | 'version-control'
  | 'shell'
  | 'web'
  | 'mcp'
  | 'subagent'
  | 'other';

export const TOOL_CATEGORY_LABELS: Record<ToolCategory, string> = {
  'file-read': 'File read',
  'file-edit': 'File edit',
  search: 'Search',
  script: 'Script',
  'tests-builds': 'Tests and builds',
  'version-control': 'Version control',
  shell: 'Shell command',
  web: 'Web',
  mcp: 'MCP tool',
  subagent: 'Subagent',
  other: 'Other',
};

/**
 * A refinement of "Shell command" from your own history: `<source>:shell/<name>`,
 * such as `user:shell/package-install`. A filter on `shell` matches it too, so
 * nothing written against the built-in categories breaks. See
 * docs/design/trusted-advisor.md#discovered-tool-categories.
 */
export type ShellSubCategoryId = `${string}:shell/${string}`;

/** A tool call's category as stored on its event: built-in, or a shell sub-category. */
export type EventToolCategory = ToolCategory | ShellSubCategoryId;

export interface ShellSubCategory {
  id: ShellSubCategoryId;
  parent: 'shell';
  label: string;
  /** Command prefixes of one or two words (`npm install`, `curl`), matched against a command's first meaningful words. */
  match: string[];
}

const SUB_CATEGORY_ID = /^[a-z][a-z0-9-]*:shell\/[a-z0-9][a-z0-9-]*$/;

/** Sub-categories in use; set by the extension from saved categories and settings. */
let activeSubCategories: ShellSubCategory[] = [];

export function setShellSubCategories(categories: ShellSubCategory[]): void {
  activeSubCategories = categories;
}

export function isShellSubCategoryId(value: string): value is ShellSubCategoryId {
  return SUB_CATEGORY_ID.test(value);
}

export function isToolCategory(value: string): value is ToolCategory {
  return Object.prototype.hasOwnProperty.call(TOOL_CATEGORY_LABELS, value);
}

/** The built-in category a category refines, or itself. */
export function baseCategory(category: EventToolCategory): ToolCategory {
  return isShellSubCategoryId(category) ? 'shell' : category;
}

/** Whether an event's category satisfies a filter on `wanted`: the same category, or a sub-category of it. */
export function categoryMatches(category: EventToolCategory, wanted: string): boolean {
  return category === wanted || (isShellSubCategoryId(category) && wanted === 'shell');
}

/** Tools recognized by name, for Claude Code and Copilot Chat. Shell tools are classified by command instead. */
const BY_NAME: Record<string, ToolCategory> = {
  // Claude Code
  Read: 'file-read',
  Edit: 'file-edit',
  MultiEdit: 'file-edit',
  Write: 'file-edit',
  NotebookEdit: 'file-edit',
  Grep: 'search',
  Glob: 'search',
  LS: 'search',
  WebFetch: 'web',
  WebSearch: 'web',
  Task: 'subagent',
  Agent: 'subagent',
  BashOutput: 'shell',
  KillShell: 'shell',
  // Copilot Chat
  read_file: 'file-read',
  apply_patch: 'file-edit',
  create_file: 'file-edit',
  insert_edit_into_file: 'file-edit',
  replace_string_in_file: 'file-edit',
  edit_file: 'file-edit',
  file_search: 'search',
  grep_search: 'search',
  semantic_search: 'search',
  list_dir: 'search',
  fetch_webpage: 'web',
  runSubagent: 'subagent',
  // Copilot CLI (Copilot agent mode in VS Code's agent host)
  view: 'file-read',
  edit: 'file-edit',
  create: 'file-edit',
  str_replace: 'file-edit',
  str_replace_editor: 'file-edit',
  rg: 'search',
  grep: 'search',
  glob: 'search',
  web_fetch: 'web',
  task: 'subagent',
};

/** Tools whose input is a shell command line. */
const SHELL_TOOLS = new Set(['Bash', 'run_in_terminal', 'bash']);

const INTERPRETERS = new Set(['python', 'python3', 'node', 'bash', 'sh', 'zsh', 'ruby', 'perl', 'deno', 'bun', 'tsx', 'ts-node']);
const TEST_RUNNERS = new Set(['pytest', 'jest', 'vitest', 'mocha', 'tox', 'nox', 'rspec', 'phpunit']);
const BUILD_TOOLS = new Set(['make', 'cmake', 'ninja', 'gradle', './gradlew', 'gradlew', 'mvn', 'tsc', 'esbuild', 'webpack', 'rollup', 'xcodebuild', 'bazel']);
const PACKAGE_MANAGERS = new Set(['npm', 'pnpm', 'yarn', 'bun']);
const PM_BUILD_SCRIPTS = /^(test|build|lint|check|typecheck|compile|ci)(:|$|-)/;
const LANG_TOOLCHAINS: Record<string, RegExp> = {
  cargo: /^(test|build|check|clippy|bench)$/,
  go: /^(test|build|vet)$/,
  dotnet: /^(test|build)$/,
  swift: /^(test|build)$/,
};

/** A command segment's words, without leading environment assignments (FOO=1 BAR=2 cmd ...). */
function commandWords(segment: string): string[] {
  let words = segment.trim().split(/\s+/).filter(Boolean);
  while (words.length > 0 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0])) words = words.slice(1);
  return words;
}

function classifyCommandSegment(words: string[]): ToolCategory | undefined {
  const [cmd, a1, a2] = words;
  if (!cmd || cmd === 'cd') return undefined;
  if (cmd === 'git' || cmd === 'gh') return 'version-control';
  if (TEST_RUNNERS.has(cmd) || BUILD_TOOLS.has(cmd)) return 'tests-builds';
  if (PACKAGE_MANAGERS.has(cmd)) {
    if (a1 === 'run' && a2 && PM_BUILD_SCRIPTS.test(a2)) return 'tests-builds';
    if (a1 && PM_BUILD_SCRIPTS.test(a1)) return 'tests-builds';
    return 'shell';
  }
  if (cmd === 'npx' && a1 && (TEST_RUNNERS.has(a1) || BUILD_TOOLS.has(a1))) return 'tests-builds';
  if (LANG_TOOLCHAINS[cmd]?.test(a1 ?? '')) return 'tests-builds';
  if ((cmd === 'python' || cmd === 'python3') && a1 === '-m' && a2 && (TEST_RUNNERS.has(a2) || a2 === 'unittest')) return 'tests-builds';
  if (INTERPRETERS.has(cmd)) {
    // Any interpreter run is a script: a local file (python tools/x.py) or code
    // written on the spot (python3 - <<EOF, python3 -c, node -e). Exceptions:
    // package tooling and version checks.
    if (a1 === '-m' && (a2 === 'pip' || a2 === 'venv')) return 'shell';
    if (!a1 || a1 === '--version' || a1 === '-V') return 'shell';
    return 'script';
  }
  if (/^\.{0,2}\//.test(cmd)) return 'script'; // ./run.sh, ../tools/x, /opt/x
  return 'shell';
}

/** The sub-category with the longest prefix of these words, if any. */
function matchSubCategory(words: string[], categories: ShellSubCategory[]): ShellSubCategoryId | undefined {
  let best: { id: ShellSubCategoryId; length: number } | undefined;
  for (const category of categories) {
    for (const prefix of category.match) {
      const want = prefix.split(/\s+/);
      if (want.length > (best?.length ?? 0) && want.every((w, i) => words[i] === w)) best = { id: category.id, length: want.length };
    }
  }
  return best?.id;
}

/**
 * Classifies a shell command line by its first meaningful segment (skipping
 * `cd …`) of an && / ; / || chain. Plain shell commands are refined by the
 * sub-categories in use.
 */
export function classifyCommand(command: string, subCategories: ShellSubCategory[] = activeSubCategories): EventToolCategory {
  for (const segment of command.split(/&&|\|\||;|\n/)) {
    const words = commandWords(segment.split('|')[0]);
    const category = classifyCommandSegment(words);
    if (category === 'shell') return matchSubCategory(words, subCategories) ?? 'shell';
    if (category) return category;
  }
  return 'shell';
}

/** Category for a tool call, from the tool's name and (for shell tools) its command line. */
export function classifyTool(toolName: string | undefined, command?: string): EventToolCategory {
  if (!toolName) return 'other';
  if (toolName.startsWith('mcp__')) return 'mcp';
  if (SHELL_TOOLS.has(toolName)) return command ? classifyCommand(command) : 'shell';
  return BY_NAME[toolName] ?? 'other';
}

/** Display label for a category; a sub-category no longer in use falls back to its id's name. */
export function categoryLabel(category: EventToolCategory): string {
  if (!isShellSubCategoryId(category)) return TOOL_CATEGORY_LABELS[category] ?? category;
  return activeSubCategories.find((c) => c.id === category)?.label ?? category.slice(category.indexOf('/') + 1);
}

/** Display label, naming the MCP server for MCP tools (e.g. "MCP: github"). */
export function toolCategoryLabel(category: EventToolCategory, toolName?: string): string {
  if (category === 'mcp' && toolName?.startsWith('mcp__')) {
    const server = toolName.split('__')[1];
    if (server) return `MCP: ${server}`;
  }
  return categoryLabel(category);
}

/** Validates a shell sub-category document (from settings or saved categories). */
export function parseShellSubCategory(doc: unknown): { value?: ShellSubCategory; errors: string[] } {
  if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) return { errors: ['a tool category must be a JSON object'] };
  const d = doc as Record<string, unknown>;
  const errors: string[] = [];
  for (const key of Object.keys(d)) if (!['id', 'parent', 'label', 'match'].includes(key)) errors.push(`unknown field "${key}"`);
  if (typeof d.id !== 'string' || !isShellSubCategoryId(d.id)) errors.push('id must look like "user:shell/package-install"');
  if (d.parent !== 'shell') errors.push('parent must be "shell": only shell commands can be split');
  if (typeof d.label !== 'string' || !d.label.trim()) errors.push('label must be a non-empty string');
  if (!Array.isArray(d.match) || d.match.length === 0) {
    errors.push('match must be a non-empty list of command prefixes');
  } else {
    for (const m of d.match) {
      const words = typeof m === 'string' ? commandWords(m) : [];
      if (words.length < 1 || words.length > 2 || words.join(' ') !== m) {
        errors.push(`match entry ${JSON.stringify(m)} must be one or two words, such as "npm install"`);
      } else if (classifyCommandSegment(words) !== 'shell') {
        errors.push(`match entry "${m}" would never apply: it's already classified as ${TOOL_CATEGORY_LABELS[classifyCommandSegment(words) ?? 'shell']}`);
      }
    }
  }
  if (errors.length > 0) return { errors };
  return { value: { id: d.id as ShellSubCategoryId, parent: 'shell', label: (d.label as string).trim(), match: d.match as string[] }, errors };
}
