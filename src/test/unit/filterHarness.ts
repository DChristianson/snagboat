import * as assert from 'assert';
import { ContextInput, Filter, FilterContext, makeContext, Rule, RULES } from '../../core/filter';

/**
 * Shared by the filter's tests (filterRule-*.unit.test.ts, filterEngine.unit.test.ts): a runner
 * in the style of the other unit tests, and helpers that run one rule, or every rule, over text.
 * Planted values are assembled from parts, so none appears whole in the repository.
 */

export const j = (...parts: string[]) => parts.join('');

export type Test = [string, () => Promise<void> | void];

export async function run(tests: Test[]): Promise<void> {
  let failures = 0;
  for (const [name, fn] of tests) {
    try {
      await fn();
      console.log(`PASS  ${name}`);
    } catch (err) {
      failures += 1;
      console.error(`FAIL  ${name}`);
      console.error(err);
    }
  }
  console.log(`\n${tests.length - failures}/${tests.length} passed`);
  if (failures > 0) process.exit(1);
}

/** What one rule finds in text: [matched text, value] pairs, in order. */
export function found(rule: Rule, text: string, ctx: FilterContext | ContextInput = {}): Array<[string, string]> {
  const c = 'resolveCommit' in ctx ? ctx : makeContext(ctx);
  return rule
    .detect(text, c)
    .sort((a, b) => a.start - b.start)
    .map((m) => [text.slice(m.start, m.end), m.value]);
}

/** text with every value of the given rules (default all) rewritten. */
export function rewritten(text: string, ctx: ContextInput = {}, rules: readonly Rule[] = RULES): string {
  const actions = Object.fromEntries(rules.map((r) => [r.id, 'rewrite' as const]));
  const f = new Filter(rules, makeContext(ctx), actions);
  f.scan(text);
  f.settle();
  return f.apply(text);
}

/** Asserts the rule finds nothing in each text. */
export function findsNothing(rule: Rule, texts: string[], ctx: ContextInput = {}): void {
  for (const t of texts) assert.deepStrictEqual(found(rule, t, ctx), [], `${rule.id} found something in ${JSON.stringify(t)}`);
}
