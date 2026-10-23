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
};

/** Tools whose input is a shell command line. */
const SHELL_TOOLS = new Set(['Bash', 'run_in_terminal']);

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

function classifyCommandSegment(words: string[]): ToolCategory | undefined {
  // Drop leading environment assignments (FOO=1 BAR=2 cmd ...).
  while (words.length > 0 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0])) words = words.slice(1);
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

/** Classifies a shell command line by its first meaningful segment (skipping `cd …`) of an && / ; / || chain. */
export function classifyCommand(command: string): ToolCategory {
  for (const segment of command.split(/&&|\|\||;|\n/)) {
    const firstOfPipe = segment.split('|')[0];
    const category = classifyCommandSegment(firstOfPipe.trim().split(/\s+/).filter(Boolean));
    if (category) return category;
  }
  return 'shell';
}

/** Category for a tool call, from the tool's name and (for shell tools) its command line. */
export function classifyTool(toolName: string | undefined, command?: string): ToolCategory {
  if (!toolName) return 'other';
  if (toolName.startsWith('mcp__')) return 'mcp';
  if (SHELL_TOOLS.has(toolName)) return command ? classifyCommand(command) : 'shell';
  return BY_NAME[toolName] ?? 'other';
}

/** Display label, naming the MCP server for MCP tools (e.g. "MCP: github"). */
export function toolCategoryLabel(category: ToolCategory, toolName?: string): string {
  if (category === 'mcp' && toolName?.startsWith('mcp__')) {
    const server = toolName.split('__')[1];
    if (server) return `MCP: ${server}`;
  }
  return TOOL_CATEGORY_LABELS[category];
}
