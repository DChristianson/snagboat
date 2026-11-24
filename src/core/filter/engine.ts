import { decisionId } from './decisions';
import type { Action, Category, Decision, FilterContext, Rule } from './types';

/**
 * The filter's engine (docs/design/export.md, "The engine"): every enabled rule over a text,
 * overlaps settled, matches grouped into review items, decisions applied in one pass.
 *
 * Overlap policy, the one place it's decided:
 * - Matches are ordered by start, then the longer first, then the rule listed first (RULES).
 * - NESTED spans (one inside another, or the same span from two rules) are separate review
 *   items. When the outer value is rewritten, nothing inside it is applied: the outer rewrite
 *   wins. When it's kept, what's inside is applied as decided. A span nested in an ancestor of
 *   the same rule and value is dropped: it can't be decided differently.
 * - CROSSING spans (each starts inside the other's span and ends outside it): the one that
 *   starts earlier wins (then the longer, then the rule listed first, by the order above); the
 *   other is dropped for that occurrence and isn't counted.
 *
 * Rules only ever see the original text, and applying writes the original text with rewritten
 * spans swapped for placeholders, so there are no sentinels and nothing to undo: applying with
 * every value kept gives back the text unchanged.
 *
 * Use: scan() every text the export will write, settle() with the decisions, then apply() each
 * text. Placeholders are numbered per rule, in the order values were first scanned, over the
 * rewritten values only.
 */

/** A value to decide on: one rule, one value, every place it occurs. */
export interface ReviewItem {
  /** decisionId(rule, value): what decisions are keyed by, without the value. */
  id: string;
  rule: string;
  category: Category;
  value: string;
  /** Occurrences, over every text scanned. */
  count: number;
  /** Up to three occurrences with some context, from the original text. */
  snippets: string[];
  /** What it becomes when rewritten: '[email-N]'. */
  becomes: string;
  /** What will happen to it; null until decided (a rule set to review). */
  decision: Decision | null;
}

/** What each rule did, by rule id: distinct values rewritten and kept. */
export type RuleCounts = Record<string, { rewritten: number; kept: number }>;

interface Node {
  rule: Rule;
  ruleIndex: number;
  start: number;
  end: number;
  value: string;
  children: Node[];
}

interface Item extends ReviewItem {
  ruleObj: Rule;
  order: number;
  placeholder?: string;
}

const SNIPPETS = 3;
const CONTEXT = 40;

export class Filter {
  private readonly enabled: Array<{ rule: Rule; index: number }>;
  private readonly trees = new Map<string, Node[]>();
  private readonly items = new Map<string, Item>();
  private settled = false;
  private readonly numbers = new Map<string, number>();

  constructor(
    rules: readonly Rule[],
    private readonly ctx: FilterContext,
    private readonly actions: Record<string, Action>
  ) {
    this.enabled = rules.map((rule, index) => ({ rule, index })).filter(({ rule }) => this.action(rule) !== 'off');
  }

  /** A rule's action for this run (its default unless actions says otherwise). */
  action(rule: Rule): Action {
    return this.actions[rule.id] ?? rule.defaultAction;
  }

  /** Detects in one text the export will write, and counts what it found. Scan every text before settle(). */
  scan(text: string): void {
    if (this.settled) throw new Error('Filter.scan after settle: scan every text first.');
    if (!text) return;
    const roots = this.tree(text);
    const walk = (nodes: Node[]) => {
      for (const n of nodes) {
        const item = this.item(n);
        item.count++;
        if (item.snippets.length < SNIPPETS) {
          const s = snippet(text, n.start, n.end);
          if (!item.snippets.includes(s)) item.snippets.push(s);
        }
        walk(n.children);
      }
    };
    walk(roots);
  }

  /** The values found, in the order first met. */
  reviewItems(): ReviewItem[] {
    return [...this.items.values()].sort((a, b) => a.order - b.order).map(publicItem);
  }

  /**
   * Decides every value: a decision `decided` gives (by item id) wins; else the rule's action
   * (rewrite, keep); else (review) it's pending. Numbers the rewritten values. Returns the
   * values still to be decided: while there are any, nothing should be written.
   */
  settle(decided: (id: string) => Decision | undefined = () => undefined): ReviewItem[] {
    const pending: ReviewItem[] = [];
    for (const item of [...this.items.values()].sort((a, b) => a.order - b.order)) {
      const action = this.action(item.ruleObj);
      const d = decided(item.id) ?? (action === 'rewrite' ? 'rewrite' : action === 'keep' ? 'keep' : undefined);
      item.decision = d ?? null;
      if (d === undefined) pending.push(publicItem(item));
      else if (d === 'rewrite') this.number(item);
    }
    this.settled = true;
    return pending;
  }

  /** The text with every rewritten value replaced, by the overlap policy. Call after settle(). */
  apply(text: string): string {
    if (!this.settled) throw new Error('Filter.apply before settle.');
    if (!text) return text;
    const roots = this.tree(text);
    let out = '';
    let pos = 0;
    const emit = (nodes: Node[]) => {
      for (const n of nodes) {
        out += text.slice(pos, n.start);
        pos = n.start;
        const item = this.items.get(key(n)) ?? this.unscanned(n);
        if (item.decision === 'rewrite') {
          out += item.placeholder!;
          pos = n.end;
        } else {
          // Kept, or undecided (never written): what's inside is applied as decided.
          emit(n.children);
          out += text.slice(pos, n.end);
          pos = n.end;
        }
      }
    };
    emit(roots);
    return out + text.slice(pos);
  }

  /** Distinct values each rule rewrote and kept, for rules that found any. */
  counts(): RuleCounts {
    const out: RuleCounts = {};
    for (const { rule } of this.enabled) {
      const mine = [...this.items.values()].filter((i) => i.ruleObj === rule);
      if (mine.length === 0) continue;
      out[rule.id] = { rewritten: mine.filter((i) => i.decision === 'rewrite').length, kept: mine.filter((i) => i.decision === 'keep').length };
    }
    return out;
  }

  // ---- internals ---------------------------------------------------------------------------

  /** The text's matches as a forest, by the overlap policy; built once per distinct text. */
  private tree(text: string): Node[] {
    const cached = this.trees.get(text);
    if (cached) return cached;
    const matches: Node[] = [];
    for (const { rule, index } of this.enabled) {
      for (const m of rule.detect(text, this.ctx)) {
        if (m.end > m.start && m.start >= 0 && m.end <= text.length) matches.push({ rule, ruleIndex: index, start: m.start, end: m.end, value: m.value, children: [] });
      }
    }
    matches.sort((a, b) => a.start - b.start || b.end - a.end || a.ruleIndex - b.ruleIndex);
    const roots: Node[] = [];
    const stack: Node[] = [];
    for (const m of matches) {
      while (stack.length > 0 && stack[stack.length - 1].end <= m.start) stack.pop();
      const parent = stack[stack.length - 1];
      // Crossing: the parent started earlier (or is longer), so it wins.
      if (parent && m.end > parent.end) continue;
      if (stack.some((a) => a.rule === m.rule && a.value === m.value)) continue;
      (parent ? parent.children : roots).push(m);
      stack.push(m);
    }
    this.trees.set(text, roots);
    return roots;
  }

  private item(n: Node): Item {
    const k = key(n);
    let item = this.items.get(k);
    if (!item) {
      item = {
        id: decisionId(n.rule.id, n.value),
        rule: n.rule.id,
        category: n.rule.category,
        value: n.value,
        count: 0,
        snippets: [],
        becomes: n.rule.becomes.replace(/`/g, ''),
        decision: null,
        ruleObj: n.rule,
        order: this.items.size,
      };
      this.items.set(k, item);
    }
    return item;
  }

  /** A value apply() met in a text scan() never saw: rewritten unless its rule keeps (fail closed). */
  private unscanned(n: Node): Item {
    const item = this.item(n);
    item.decision = this.action(n.rule) === 'keep' ? 'keep' : 'rewrite';
    if (item.decision === 'rewrite') this.number(item);
    return item;
  }

  private number(item: Item): void {
    if (item.placeholder !== undefined) return;
    const n = (this.numbers.get(item.rule) ?? 0) + 1;
    this.numbers.set(item.rule, n);
    item.placeholder = item.ruleObj.replace(item.value, n, this.ctx);
  }
}

const key = (n: Node) => `${n.rule.id}\0${n.value}`;

function publicItem(i: Item): ReviewItem {
  return { id: i.id, rule: i.rule, category: i.category, value: i.value, count: i.count, snippets: [...i.snippets], becomes: i.becomes, decision: i.decision };
}

/** The match with up to CONTEXT characters each side, whitespace collapsed. */
function snippet(text: string, start: number, end: number): string {
  const from = Math.max(0, start - CONTEXT);
  const to = Math.min(text.length, end + CONTEXT);
  return `${from > 0 ? '…' : ''}${text.slice(from, to)}${to < text.length ? '…' : ''}`.replace(/\s+/g, ' ');
}
