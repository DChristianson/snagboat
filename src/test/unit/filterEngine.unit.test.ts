import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  decisionId,
  DECISIONS_FILE,
  Filter,
  foldReviewFile,
  loadDecisions,
  makeContext,
  parseRuleOption,
  removeReviewFile,
  resolveActions,
  REVIEW_FILE,
  ReviewFile,
  Rule,
  RULE_TABLE_DOCS,
  RULES,
  ruleTable,
  saveDecisions,
  TABLE_END,
  TABLE_START,
  writeReviewFile,
} from '../../core/filter';
import { j, rewritten, run } from './filterHarness';

// The engine (overlap policy, grouping, apply), the actions' precedence, decisions kept in the
// store, and the generated rule table. Each rule's own cases are in filterRule-<id>.unit.test.ts.

const HOME = j('/home/', 'qz', 'user');
const PROJECT = j(HOME, '/work/', 'acme-app');
const EMAIL = j('robin', '@', 'example.org');

/** A rule that finds fixed spans, for the overlap policy. */
const fixed = (id: string, spans: Array<[number, number]>, defaultAction: Rule['defaultAction'] = 'rewrite'): Rule => ({
  id,
  category: 'Other',
  describe: id,
  becomes: `[${id}]`,
  defaultAction,
  detect: (text) => spans.filter(([, e]) => e <= text.length).map(([start, end]) => ({ start, end, value: `${id}:${start}-${end}` })),
  replace: (_v, n) => `[${id}${n}]`,
});

function filter(rules: readonly Rule[], actions: Record<string, Rule['defaultAction']> = {}, ctx = makeContext()) {
  return new Filter(rules, ctx, actions);
}

run([
  ['nested spans are separate items; an outer rewrite wins, a kept outer applies what is inside', () => {
    const text = `cd ${PROJECT}/src`;
    const ctx = makeContext({ projectRoot: PROJECT });
    const decide = (project: 'rewrite' | 'keep', home: 'rewrite' | 'keep') => {
      const f = new Filter(RULES, ctx, {});
      f.scan(text);
      const items = f.reviewItems();
      assert.deepStrictEqual(items.map((i) => [i.rule, i.value]), [['project-path', PROJECT], ['home-path', HOME]]);
      f.settle((id) => (id === items[0].id ? project : home));
      return f.apply(text);
    };
    assert.strictEqual(decide('rewrite', 'rewrite'), 'cd ./src');
    assert.strictEqual(decide('rewrite', 'keep'), 'cd ./src');
    assert.strictEqual(decide('keep', 'rewrite'), 'cd ~/work/acme-app/src');
    assert.strictEqual(decide('keep', 'keep'), text);
  }],
  ['crossing spans: the earlier-starting wins, then the longer; the loser is dropped and not counted', () => {
    const text = 'abcdefghij';
    const f = filter([fixed('a', [[0, 5]]), fixed('b', [[3, 8]])]);
    f.scan(text);
    assert.deepStrictEqual(f.reviewItems().map((i) => i.rule), ['a']);
    f.settle();
    assert.strictEqual(f.apply(text), '[a1]fghij');
    const g = filter([fixed('a', [[2, 5]]), fixed('b', [[2, 8]])]);
    g.scan(text);
    g.settle();
    assert.strictEqual(g.apply(text), 'ab[b1]ij', 'same start: the longer is the outer');
    // The same span from two rules: nested, the rule listed first outside.
    const h = filter([fixed('a', [[2, 5]]), fixed('b', [[2, 5]])], { a: 'keep' });
    h.scan(text);
    assert.deepStrictEqual(h.reviewItems().map((i) => i.rule), ['a', 'b']);
    h.settle();
    assert.strictEqual(h.apply(text), 'ab[b1]fghij');
  }],
  ['a span nested in one of the same rule and value is dropped', () => {
    const r: Rule = { ...fixed('a', []), detect: () => [{ start: 0, end: 6, value: 'v' }, { start: 1, end: 3, value: 'v' }, { start: 2, end: 4, value: 'w' }] };
    const f = filter([r]);
    f.scan('abcdefg');
    assert.deepStrictEqual(f.reviewItems().map((i) => [i.value, i.count]), [['v', 1], ['w', 1]]);
  }],
  ['grouping: one item per rule and value, with its count over every text and up to three snippets', () => {
    const f = filter(RULES);
    for (let i = 0; i < 5; i++) f.scan(`line ${i}: mail ${EMAIL} please`);
    f.scan(`${EMAIL} again`);
    const items = f.reviewItems();
    assert.strictEqual(items.length, 1);
    assert.strictEqual(items[0].count, 6);
    assert.strictEqual(items[0].snippets.length, 3);
    assert.ok(items[0].snippets[0].includes(`mail ${EMAIL} please`), items[0].snippets[0]);
    assert.strictEqual(items[0].id, decisionId('email', EMAIL));
    assert.strictEqual(items[0].becomes, '[email-N]');
    assert.strictEqual(items[0].decision, null);
  }],
  ['undecided review values are pending; rewrite and keep rules settle themselves', () => {
    const f = filter([fixed('r', [[0, 1]], 'review'), fixed('w', [[2, 3]], 'rewrite'), fixed('k', [[4, 5]], 'keep')]);
    f.scan('abcdef');
    const pending = f.settle();
    assert.deepStrictEqual(pending.map((p) => p.rule), ['r']);
    assert.strictEqual(f.apply('abcdef'), 'ab[w1]def', 'an undecided value is never rewritten; nothing should be written while one is pending');
    assert.deepStrictEqual(f.counts(), { r: { rewritten: 0, kept: 0 }, w: { rewritten: 1, kept: 0 }, k: { rewritten: 0, kept: 1 } });
    assert.throws(() => f.scan('x'), /after settle/);
    assert.throws(() => filter([]).apply('x'), /before settle/);
  }],
  ['placeholders are numbered over rewritten values only, in the order first met, consistently', () => {
    const emails = ['a1@example.org', 'b2@example.org', 'c3@example.org'];
    const f = filter(RULES);
    f.scan(emails.join(' '));
    const keepB = decisionId('email', emails[1]);
    f.settle((id) => (id === keepB ? 'keep' : 'rewrite'));
    assert.strictEqual(f.apply(emails.join(' ')), `[email-1] ${emails[1]} [email-2]`);
    assert.strictEqual(f.apply(`again ${emails[2]}`), 'again [email-2]', 'a text scanned elsewhere gets the same placeholder');
  }],
  ['applying with every value kept gives back the text: no sentinels, nothing else touched', () => {
    const texts = [
      `Read ${PROJECT}/src/app.ts; mail ${EMAIL}; box 10.20.30.40; key ${j('AKIA', 'QZQZQZQZQZQZQZQZ')}`,
      'Run npm test in src/core, then git log --oneline -5. Version 1.2.3 is fine; see https://github.com/microsoft/vscode/issues/123 and @types/node.',
      ' private-use characters pass through',
    ];
    const keepAll = Object.fromEntries(RULES.map((r) => [r.id, 'keep' as const]));
    const f = new Filter(RULES, makeContext({ projectRoot: PROJECT }), keepAll);
    for (const t of texts) f.scan(t);
    f.settle();
    for (const t of texts) assert.strictEqual(f.apply(t), t);
  }],
  ['ordinary text is left alone by every rule', () => {
    const text = 'Run npm test in src/core, then git log --oneline -5. Version 1.2.3 is fine; see https://github.com/microsoft/vscode/issues/123 and @types/node.';
    const f = filter(RULES);
    f.scan(text);
    assert.deepStrictEqual(f.reviewItems(), []);
  }],
  ['every rule at once, rewritten: each finds its own value in the original text', () => {
    const text = `cd ${PROJECT} && mail ${EMAIL} from 10.20.30.40 with ${j('ghp_', 'Ab1'.repeat(12))}`;
    assert.strictEqual(rewritten(text, { projectRoot: PROJECT }), 'cd . && mail [email-1] from [ip-1] with [secret]');
  }],
  ['actions: rule default < export.rules < --rule, --rewrite-all, --no-filter (< a decision, in settle)', () => {
    const def = resolveActions(RULES);
    assert.strictEqual(def.actions.email, 'review');
    assert.strictEqual(def.actions.sha, 'keep');
    assert.strictEqual(def.mode, 'reviewed');
    const set = resolveActions(RULES, { setting: { sha: 'rewrite', ip: 'keep', nope: 'keep', email: 'maybe' } });
    assert.strictEqual(set.actions.sha, 'rewrite');
    assert.strictEqual(set.actions.ip, 'keep');
    assert.strictEqual(set.actions.email, 'review');
    assert.strictEqual(set.problems.length, 2, set.problems.join('\n'));
    const cli = resolveActions(RULES, { setting: { ip: 'keep' }, rules: { ip: 'rewrite' } });
    assert.strictEqual(cli.actions.ip, 'rewrite', '--rule beats the setting');
    const all = resolveActions(RULES, { setting: { ip: 'keep' }, rewriteAll: true, rules: { sha: 'keep' } });
    assert.ok(RULES.every((r) => all.actions[r.id] === (r.id === 'sha' ? 'keep' : 'rewrite')), '--rewrite-all, and --rule beats it');
    assert.strictEqual(all.mode, 'rewrite-all');
    const none = resolveActions(RULES, { noFilter: true });
    assert.ok(RULES.every((r) => none.actions[r.id] === 'off'));
    assert.strictEqual(none.mode, 'none');
    assert.throws(() => resolveActions(RULES, { noFilter: true, rewriteAll: true }), /--no-filter/);
    assert.throws(() => resolveActions(RULES, { rules: { nope: 'keep' } }), /no rule nope/);
    assert.deepStrictEqual(parseRuleOption('email=rewrite'), { id: 'email', action: 'rewrite' });
    assert.strictEqual(typeof parseRuleOption('email'), 'string');
    assert.strictEqual(typeof parseRuleOption('email=sometimes'), 'string');
    // A decision on a value beats every layer, --rewrite-all included.
    const f = new Filter(RULES, makeContext(), all.actions);
    f.scan(`mail ${EMAIL}`);
    f.settle((id) => (id === decisionId('email', EMAIL) ? 'keep' : undefined));
    assert.strictEqual(f.apply(`mail ${EMAIL}`), `mail ${EMAIL}`);
  }],
  ['an off rule never runs', () => {
    let ran = false;
    const r: Rule = { ...fixed('x', [[0, 1]]), detect: () => ((ran = true), []) };
    const f = filter([r], { x: 'off' });
    f.scan('abc');
    assert.ok(!ran);
  }],
  ['decisions persist by a hash of rule and value, never the value; the review file folds into them', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snagboat-decisions-'));
    try {
      const now = new Date('2026-11-24T12:00:00Z');
      assert.strictEqual(loadDecisions(dir).size, 0);
      saveDecisions(dir, [{ id: decisionId('email', EMAIL), rule: 'email', decision: 'keep' }], now);
      assert.strictEqual(loadDecisions(dir).get(decisionId('email', EMAIL)), 'keep');
      const raw = fs.readFileSync(path.join(dir, DECISIONS_FILE), 'utf8');
      assert.ok(!raw.includes(EMAIL), 'the decisions file never holds the value');
      if (process.platform !== 'win32') assert.strictEqual(fs.statSync(path.join(dir, DECISIONS_FILE)).mode & 0o777, 0o600);

      const f = filter(RULES);
      f.scan(`mail ${EMAIL} at 10.20.30.40 and 10.20.30.41`);
      const pending = f.settle((id) => loadDecisions(dir).get(id));
      assert.deepStrictEqual(pending.map((p) => p.value), ['10.20.30.40', '10.20.30.41'], 'only values not decided before');
      const file = writeReviewFile(dir, PROJECT, pending, now);
      assert.strictEqual(file, path.join(dir, REVIEW_FILE));
      const review = JSON.parse(fs.readFileSync(file, 'utf8')) as ReviewFile;
      assert.strictEqual(review.items.length, 2);
      assert.ok(review.items.every((i) => i.decision === null && i.snippets.length > 0 && i.count === 1));
      review.items[0].decision = 'rewrite';
      (review.items[1] as { decision: unknown }).decision = 'sometimes';
      fs.writeFileSync(file, JSON.stringify(review));
      const folded = foldReviewFile(dir, now);
      assert.strictEqual(folded.folded, 1);
      assert.strictEqual(folded.problems.length, 1);
      const d = loadDecisions(dir);
      assert.strictEqual(d.get(decisionId('ip', '10.20.30.40')), 'rewrite');
      assert.strictEqual(d.get(decisionId('ip', '10.20.30.41')), undefined);
      assert.strictEqual(d.get(decisionId('email', EMAIL)), 'keep', 'earlier decisions stay');
      removeReviewFile(dir);
      assert.ok(!fs.existsSync(file));
      assert.deepStrictEqual(foldReviewFile(dir, now), { folded: 0, problems: [] });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }],
  ['the rule table is generated from the rules, and the docs carry the current one', () => {
    const table = ruleTable();
    for (const r of RULES) assert.ok(table.includes(`| \`${r.id}\` |`), r.id);
    assert.strictEqual(new Set(RULES.map((r) => r.id)).size, RULES.length, 'rule ids are unique');
    const root = path.resolve(__dirname, '..', '..', '..');
    for (const doc of RULE_TABLE_DOCS) {
      const text = fs.readFileSync(path.join(root, doc), 'utf8').replace(/\r\n/g, '\n');
      const start = text.indexOf(TABLE_START);
      const end = text.indexOf(TABLE_END);
      assert.ok(start >= 0 && end > start, `${doc} has no rule-table markers`);
      assert.strictEqual(text.slice(start + TABLE_START.length + 1, end), table, `${doc}'s rule table is stale: run npm run docs:rules`);
    }
  }],
  ['each rule file is one rule, and the filter imports nothing from the export code', () => {
    const dir = path.resolve(__dirname, '..', '..', '..', 'src', 'core', 'filter');
    const files = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(path.join(d, e.name)) : [path.join(d, e.name)]));
    for (const f of files(dir)) {
      for (const [, spec] of fs.readFileSync(f, 'utf8').matchAll(/from\s+'([^']+)'/g)) {
        if (!spec.startsWith('.')) assert.ok(['crypto', 'fs', 'path', 'net'].includes(spec), `${path.relative(dir, f)} imports ${spec}`);
        else assert.ok(!path.relative(dir, path.resolve(path.dirname(f), spec)).startsWith('..'), `${path.relative(dir, f)} imports ${spec}, outside the filter`);
      }
    }
    const ruleFiles = fs.readdirSync(path.join(dir, 'rules')).filter((f) => !['index.ts', 'util.ts'].includes(f));
    assert.deepStrictEqual(ruleFiles.map((f) => f.replace(/\.ts$/, '')).sort(), RULES.map((r) => r.id).sort());
  }],
]);
