import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runCli } from '../../cli/main';
import {
  configHost,
  effectiveSettings,
  findProjectFile,
  isSyncedSetting,
  loadConfig,
  PRIVACY_DEFAULTS,
  saveConfig,
  SnagboatConfig,
  withVsCodeSettings,
} from '../../core/config';

// Settings outside VS Code (docs/design/handoff-3c.md, 3c-3a): ~/.snagboat/config.json's
// defaults and project entries, a project's committed .snagboat.json (team settings, and
// privacy settings only toward more private), and windows copying VS Code's settings in.

function setup(config?: Partial<SnagboatConfig>) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'snagboat-config-')));
  const home = path.join(root, 'home', '.snagboat');
  const repo = path.join(root, 'src', 'repo');
  const sub = path.join(repo, 'packages', 'app');
  fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
  fs.mkdirSync(sub, { recursive: true });
  if (config) saveConfig(home, { version: 1, defaults: {}, projects: {}, ...config });
  const projectFile = (settings: unknown, dir = repo) => fs.writeFileSync(path.join(dir, '.snagboat.json'), JSON.stringify({ settings }));
  return { root, home, repo, sub, projectFile };
}

async function main() {
  const tests: Array<[string, () => Promise<void> | void]> = [];
  const test = (name: string, fn: () => Promise<void> | void) => tests.push([name, fn]);

  test("privacy defaults match package.json's", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', '..', 'package.json'), 'utf8'));
    const props = pkg.contributes.configuration.properties ?? Object.assign({}, ...pkg.contributes.configuration.map((c: { properties: object }) => c.properties));
    for (const [key, value] of Object.entries(PRIVACY_DEFAULTS)) {
      if (key === 'collect') continue; // not a VS Code setting
      assert.strictEqual(props[`snagboat.${key}`]?.default, value, key);
    }
  });

  test('layers: defaults, then the nearest project entry, then the project file', () => {
    const { home, repo, sub, root, projectFile } = setup();
    saveConfig(home, {
      version: 1,
      defaults: { 'heuristics.stalled.minutes': 20, captureContent: true },
      projects: { [path.join(root, 'src')]: { 'heuristics.stalled.minutes': 25 }, [repo]: { 'heuristics.stalled.minutes': 30, 'retention.textDays': 14 } },
    });
    projectFile({ 'heuristics.stalled.minutes': 45 });
    const s = effectiveSettings(home, sub);
    assert.deepStrictEqual(s.values, { 'heuristics.stalled.minutes': 45, captureContent: true, 'retention.textDays': 14 });
    assert.deepStrictEqual(s.sources, { 'heuristics.stalled.minutes': 'repository', captureContent: 'user', 'retention.textDays': 'project' });
    assert.strictEqual(s.files.projectFolder, repo, 'the nearest entry, not its parent');
    assert.strictEqual(s.files.projectFile, path.join(repo, '.snagboat.json'));
    assert.deepStrictEqual(s.problems, []);
    assert.deepStrictEqual(effectiveSettings(home, path.join(root, 'elsewhere')).values, { 'heuristics.stalled.minutes': 20, captureContent: true });
  });

  test('a project file can make privacy settings more private, never less', () => {
    const { home, repo, projectFile } = setup({ defaults: { captureContent: false, 'retention.textDays': 7, 'retention.aggregateDays': 365 } });
    projectFile({ captureContent: true, 'retention.textDays': 30, 'retention.rawDays': 10, 'retention.aggregateDays': -1, collect: false, 'copilot.captureStructure': true });
    const s = effectiveSettings(home, repo);
    assert.strictEqual(s.values.captureContent, false, "can't turn capture back on");
    assert.strictEqual(s.values['retention.textDays'], 7, "can't keep text longer");
    assert.strictEqual(s.values['retention.rawDays'], 10, 'can keep raw events shorter than the default 90');
    assert.strictEqual(s.values['retention.aggregateDays'], 365, '-1 (forever) is longer than 365');
    assert.strictEqual(s.values.collect, false, 'can opt the project out');
    assert.ok(!('copilot.captureStructure' in s.values), "can't turn structure capture on");
    assert.strictEqual(s.problems.length, 4, s.problems.join('\n'));

    const { home: h2, repo: r2, projectFile: pf2 } = setup();
    pf2({ captureContent: false, 'retention.aggregateDays': 30 });
    assert.deepStrictEqual(effectiveSettings(h2, r2).values, { captureContent: false, 'retention.aggregateDays': 30 }, 'tighter than the built-in defaults');
  });

  test("a project file can't set where data goes or which advisor gets it", () => {
    const { home, repo, projectFile } = setup();
    projectFile({ 'advisor.providers': [{ id: 'x', baseUrl: 'https://example.com' }], 'storage.perUserStore': true, 'copilot.otlpPort': 1, rules: [{ id: 'r' }], 'nudges.notify': 'all' });
    const s = effectiveSettings(home, repo);
    assert.deepStrictEqual(Object.keys(s.values).sort(), ['nudges.notify', 'rules']);
    assert.strictEqual(s.problems.length, 3);
  });

  test('the project file is looked for up to the repository root, or the project entry', () => {
    const { repo, sub, root } = setup();
    fs.writeFileSync(path.join(root, 'src', '.snagboat.json'), '{"settings":{}}');
    assert.strictEqual(findProjectFile(sub), undefined, "stops at .git, so a file above the repository doesn't apply");
    fs.writeFileSync(path.join(repo, '.snagboat.json'), '{"settings":{}}');
    assert.strictEqual(findProjectFile(sub), path.join(repo, '.snagboat.json'));
    fs.rmSync(path.join(repo, '.git'), { recursive: true });
    fs.rmSync(path.join(repo, '.snagboat.json'));
    assert.strictEqual(findProjectFile(sub, repo), undefined, 'stops at the project entry folder');
  });

  test('unreadable files are ignored and reported', () => {
    const { home, repo } = setup();
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(path.join(home, 'config.json'), '{ nope');
    assert.strictEqual(loadConfig(home).problems.length, 1);
    fs.writeFileSync(path.join(repo, '.snagboat.json'), '{"captureContent":false}');
    const s = effectiveSettings(home, repo);
    assert.deepStrictEqual(s.values, {});
    assert.strictEqual(s.problems.length, 2, 'bad config.json, and a project file with no "settings"');
  });

  test('configHost answers the engine as VS Code would', () => {
    const { home, repo, root } = setup();
    saveConfig(home, { version: 1, defaults: { 'heuristics.stalled.minutes': 20, 'heuristics.stalled.maxMinutes': 60, captureContent: false }, projects: { [path.join(root, 'other')]: { captureContent: true } } });
    const h = configHost(home, repo);
    assert.strictEqual(h.get('snagboat', 'captureContent', true), false);
    assert.strictEqual(h.get('snagboat', 'retention.textDays', 30), 30, 'unset: the fallback');
    assert.strictEqual(h.get('snagboat.heuristics', 'stalled.minutes', 15), 20);
    assert.deepStrictEqual(h.section('snagboat.heuristics.stalled'), { minutes: 20, maxMinutes: 60 });
    assert.strictEqual(h.get('snagboat', 'captureContent', false, path.join(root, 'other')), true, 'scope picks another project');
    assert.strictEqual(h.get('editor', 'fontSize', 12), 12);
    assert.deepStrictEqual(h.workspaceFolders(), []);
  });

  test("VS Code's settings replace only VS Code's keys, and only for its own folders", () => {
    const current: SnagboatConfig = {
      version: 1,
      defaults: { captureContent: false, collect: true, 'heuristics.stalled.minutes': 20 },
      projects: { '/w/a': { 'retention.textDays': 7, collect: false }, '/w/b': { captureContent: false }, '/w/c': { 'heuristics.stalled.minutes': 9 } },
    };
    const keys = ['captureContent', 'retention.textDays', 'heuristics.stalled.minutes', 'advisor.providers', 'storage.perUserStore'];
    const next = withVsCodeSettings(current, keys, { 'heuristics.stalled.minutes': 30, 'advisor.providers': [] }, { '/w/a': {}, '/w/c': {}, '/w/d': { captureContent: false } });
    assert.deepStrictEqual(next.defaults, { collect: true, 'heuristics.stalled.minutes': 30, 'advisor.providers': [] }, 'captureContent unset in VS Code now; collect (hand-written) kept; which advisors exist copied (step 5c-2b)');
    assert.deepStrictEqual(next.projects, { '/w/a': { collect: false }, '/w/b': { captureContent: false }, '/w/d': { captureContent: false } }, "a's VS Code keys cleared, b untouched (another window's), c emptied and removed, d added");
    assert.ok(isSyncedSetting('advisor.providers') && isSyncedSetting('advisors') && isSyncedSetting('advisor.defaults') && isSyncedSetting('rules'));
    assert.ok(!isSyncedSetting('storage.perUserStore') && !isSyncedSetting('advisor.headlines') && !isSyncedSetting('advisor.reviewDirectory') && !isSyncedSetting('advisor.auditPayloads'), "where data lives, and what only VS Code's advisor uses");
  });

  test('`snagboat config` shows the effective settings and where they came from', async () => {
    const { home, repo, projectFile } = setup({ defaults: { captureContent: false } });
    projectFile({ 'heuristics.stalled.minutes': 45, 'advisor.providers': [] });
    const saved = process.env.SNAGBOAT_HOME;
    process.env.SNAGBOAT_HOME = home;
    try {
      let out = '';
      const io = { out: (t: string) => (out += t), err: () => undefined, cwd: repo, now: new Date() };
      assert.strictEqual(await runCli(['config', '--json'], io, 'test'), 0);
      const json = JSON.parse(out);
      assert.deepStrictEqual(json.values, { captureContent: false, 'heuristics.stalled.minutes': 45 });
      assert.strictEqual(json.problems.length, 1);
      out = '';
      await runCli(['config'], io, 'test');
      assert.ok(out.includes('heuristics.stalled.minutes = 45  (repository)') && out.includes('ignored:'), out);
    } finally {
      if (saved === undefined) delete process.env.SNAGBOAT_HOME;
      else process.env.SNAGBOAT_HOME = saved;
    }
  });

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

main();
