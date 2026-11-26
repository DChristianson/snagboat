/**
 * Rewrites the export filter's rule table in the docs from the rules themselves (core/filter's
 * ruleTable()), between the rule-table markers. Dev tooling: run it after changing a rule's
 * description, id, category or default; filterEngine.unit.test.ts fails while a doc is stale.
 *
 *   npm run docs:rules
 */
import * as fs from 'fs';
import * as path from 'path';
import { RULE_TABLE_DOCS, ruleTable, withRuleTable } from '../core/filter';

const root = path.resolve(__dirname, '..', '..');
const table = ruleTable();
for (const doc of RULE_TABLE_DOCS) {
  const file = path.join(root, doc);
  const text = fs.readFileSync(file, 'utf8');
  const next = withRuleTable(text, table);
  if (next === undefined) {
    console.error(`${doc}: no rule-table markers`);
    process.exitCode = 1;
  } else if (next !== text) {
    fs.writeFileSync(file, next);
    console.log(`${doc}: rule table updated`);
  } else console.log(`${doc}: up to date`);
}
