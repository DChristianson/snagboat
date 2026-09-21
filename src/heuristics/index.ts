import * as vscode from 'vscode';
import { Heuristic } from './types';
import { stalledHeuristic } from './stalled';

export function builtInHeuristics(): Heuristic[] {
  return [stalledHeuristic];
}

/**
 * Snapshot of a single heuristic's own settings section as a plain object, so
 * HeuristicContext.settings stays a simple bag rather than exposing the
 * vscode WorkspaceConfiguration API to (deliberately vscode-free) heuristics.
 */
export function heuristicSettings(id: string): Record<string, unknown> {
  const config = vscode.workspace.getConfiguration(`snagboat.heuristics.${id}`);
  return { ...config };
}
