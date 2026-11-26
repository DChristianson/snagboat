import { RULES } from './rules';
import type { Rule } from './types';
import { CATEGORIES } from './types';

/**
 * The rule table, generated from the rules themselves, for the docs (between the rule-table
 * markers in docs/design/export.md and PRIVACY.md; `npm run docs:rules` rewrites them, and a
 * test checks them) and for each export's README.md. Changing a rule's description changes
 * its file only.
 */

/** The docs that carry the rule table, from the repository's root. */
export const RULE_TABLE_DOCS = ['docs/design/export.md', 'PRIVACY.md'];

export const TABLE_START = '<!-- rule-table:start -->';
export const TABLE_END = '<!-- rule-table:end -->';

const cell = (s: string) => s.replace(/\|/g, '\\|').replace(/\n/g, ' ');

/** The rule table as Markdown, by category. */
export function ruleTable(rules: readonly Rule[] = RULES): string {
  const lines = ['| Category | Rule | Finds | Becomes | Default |', '| --- | --- | --- | --- | --- |'];
  for (const category of CATEGORIES) {
    for (const r of rules.filter((x) => x.category === category)) {
      lines.push(`| ${category} | \`${r.id}\` | ${cell(r.describe)} | ${cell(r.becomes)} | ${r.defaultAction} |`);
    }
  }
  return lines.join('\n') + '\n';
}

/** doc with the text between its rule-table markers replaced by table; undefined when it has no markers. */
export function withRuleTable(doc: string, table: string = ruleTable()): string | undefined {
  const start = doc.indexOf(TABLE_START);
  const end = doc.indexOf(TABLE_END);
  if (start < 0 || end < start) return undefined;
  return `${doc.slice(0, start + TABLE_START.length)}\n${table}${doc.slice(end)}`;
}
