import { Heuristic } from './types';
import { stalledHeuristic } from './stalled';
import { tokenBudgetHeuristic } from './tokenBudget';
import { toolChurnHeuristic } from './toolChurn';
import { backtrackingHeuristic } from './backtracking';
import { verbalHedgeHeuristic } from './verbalHedge';

/** Every built-in heuristic. Kept free of the vscode module so dev scripts can replay them. */
export function builtInHeuristics(): Heuristic[] {
  return [stalledHeuristic, tokenBudgetHeuristic, toolChurnHeuristic, backtrackingHeuristic, verbalHedgeHeuristic];
}
