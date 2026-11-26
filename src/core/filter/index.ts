// The privacy filter (docs/design/export.md, "The privacy filter"): a rule per file in rules/,
// one engine, the actions each run takes, decisions kept per workspace, and the generated rule
// table. It imports nothing from the export code; the export (core/exportFields.ts) hands it
// strings and writes back what it returns.
export * from './types';
export * from './people';
export * from './context';
export * from './engine';
export * from './actions';
export * from './decisions';
export * from './table';
export { RULES, ruleById } from './rules';
