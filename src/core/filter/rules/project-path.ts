import type { FilterContext, Match, Rule } from '../types';
import { escapeRegExp, spans } from './util';

/** The project's root, its worktrees and --match paths, each with what it becomes. */
function roots(ctx: FilterContext): Array<{ root: string; label: string }> {
  return [
    ...(ctx.projectRoot ? [{ root: ctx.projectRoot, label: '.' }] : []),
    ...ctx.worktrees.map((root, i) => ({ root, label: `[worktree-${i + 1}]` })),
    ...ctx.matchPaths.map((root, i) => ({ root, label: `[match-${i + 1}]` })),
  ].filter((r) => r.root.length > 1);
}

export const projectPath: Rule = {
  id: 'project-path',
  category: 'Local directories',
  describe: "The project's folder, its other worktrees' and the `--match` paths, wherever text names them (in `file://` URLs too).",
  becomes: '`.`, `[worktree-N]`, `[match-N]`',
  defaultAction: 'review',
  detect(text: string, ctx: FilterContext): Match[] {
    const out: Match[] = [];
    for (const { root } of roots(ctx)) {
      if (!text.includes(root)) continue;
      // Not inside a longer path or word, and not continuing into a longer name (acme-app-wt2).
      const re = new RegExp(`(?<![\\w.~/\\\\-])(?:file://)?${escapeRegExp(root)}(?![\\w.-])`, 'g');
      out.push(...spans(re, text, () => root));
    }
    return out;
  },
  replace(value: string, _n: number, ctx: FilterContext): string {
    return roots(ctx).find((r) => r.root === value)?.label ?? '.';
  },
};
