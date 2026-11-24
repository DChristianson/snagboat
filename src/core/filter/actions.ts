import { Action, ACTIONS, Rule } from './types';

/**
 * Which action each rule takes in a run (docs/design/export.md, "Actions, and how one is
 * chosen"). Each layer overrides the one before:
 *   1. the rule's default;
 *   2. the export.rules setting: { "sha": "rewrite", "ip": "keep" };
 *   3. the command line: --rewrite-all (every rule rewrite), then --rule id=action for its rule;
 *      --no-filter (every rule off) takes neither;
 *   4. a decision on one value, which the engine applies (Filter.settle).
 */

export interface ActionOptions {
  /** The export.rules setting's value, unchecked. */
  setting?: unknown;
  /** --rule id=action, by rule id. */
  rules?: Record<string, Action>;
  rewriteAll?: boolean;
  noFilter?: boolean;
}

/** What a run did, for the manifest: every rule ran and each value was decided, --rewrite-all, or --no-filter. */
export type FilterMode = 'reviewed' | 'rewrite-all' | 'none';

const isAction = (a: unknown): a is Action => typeof a === 'string' && (ACTIONS as readonly string[]).includes(a);

/**
 * Each rule's action. Problems with the setting (an unknown rule, an action that isn't one) are
 * returned and that entry ignored; problems with the command line throw, since the user typed them.
 */
export function resolveActions(rules: readonly Rule[], opts: ActionOptions = {}): { actions: Record<string, Action>; mode: FilterMode; problems: string[] } {
  const problems: string[] = [];
  const known = new Set(rules.map((r) => r.id));
  const actions: Record<string, Action> = {};
  for (const r of rules) actions[r.id] = r.defaultAction;
  if (opts.setting !== undefined) {
    if (!opts.setting || typeof opts.setting !== 'object' || Array.isArray(opts.setting)) {
      problems.push('export.rules is ignored: it should be an object of rule ids and actions, such as { "sha": "rewrite" }');
    } else {
      for (const [id, a] of Object.entries(opts.setting as Record<string, unknown>)) {
        if (!known.has(id)) problems.push(`export.rules: no rule ${id}; the rules are ${[...known].join(', ')}`);
        else if (!isAction(a)) problems.push(`export.rules: ${id} is ${JSON.stringify(a)}; an action is ${ACTIONS.join(', ')}`);
        else actions[id] = a;
      }
    }
  }
  const cli = Object.entries(opts.rules ?? {});
  if (opts.noFilter && (opts.rewriteAll || cli.length > 0)) throw new Error('--no-filter turns every rule off, so it takes no --rule or --rewrite-all.');
  for (const [id, a] of cli) {
    if (!known.has(id)) throw new Error(`--rule: no rule ${id}; the rules are ${[...known].join(', ')}`);
    if (!isAction(a)) throw new Error(`--rule ${id}=${a}: an action is ${ACTIONS.join(', ')}`);
  }
  if (opts.noFilter) for (const id of known) actions[id] = 'off';
  if (opts.rewriteAll) for (const id of known) actions[id] = 'rewrite';
  for (const [id, a] of cli) actions[id] = a;
  return { actions, mode: opts.noFilter ? 'none' : opts.rewriteAll ? 'rewrite-all' : 'reviewed', problems };
}

/** Parses one --rule value, `id=action`. */
export function parseRuleOption(value: string): { id: string; action: Action } | string {
  const m = /^\s*([a-z0-9-]+)\s*=\s*([a-z]+)\s*$/.exec(value);
  if (!m) return `--rule takes <rule>=<action> (such as email=rewrite), not ${value}`;
  if (!isAction(m[2])) return `--rule ${m[1]}=${m[2]}: an action is ${ACTIONS.join(', ')}`;
  return { id: m[1], action: m[2] };
}
