import * as vscode from 'vscode';
export { builtInHeuristics } from './builtIns';

// Most heuristic settings live under `snagboat.heuristics.<id>.*` with `id`
// used verbatim, but two heuristics need an override: `token-budget`'s
// settings predate this engine (already named in README.md as
// `snagboat.tokenBudget.session`/`.day`, no `heuristics.` prefix at all), and
// `tool-churn`'s settings section is camelCase (`toolChurn`) even though its
// id stays kebab-case to match docs/heuristics.md. Neither is an accident to
// paper over -- they're both real naming decisions, just not a single pattern.
const SETTINGS_SECTION: Record<string, string> = {
  'token-budget': 'snagboat.tokenBudget',
  'tool-churn': 'snagboat.heuristics.toolChurn',
  'verbal-hedge': 'snagboat.heuristics.verbalHedge',
};

/**
 * Snapshot of a single heuristic's own settings section as a plain object, so
 * HeuristicContext.settings stays a simple bag rather than exposing the
 * vscode WorkspaceConfiguration API to (deliberately vscode-free) heuristics.
 */
export function heuristicSettings(id: string): Record<string, unknown> {
  const section = SETTINGS_SECTION[id] ?? `snagboat.heuristics.${id}`;
  const config = vscode.workspace.getConfiguration(section);
  return { ...config };
}
