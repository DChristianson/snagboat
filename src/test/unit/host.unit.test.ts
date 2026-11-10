import * as assert from 'assert';
import { Host, host, setHost } from '../../core/host';
import { hooksEnabledFor, resolveProjectDir, resolveWorkspaceFolders } from '../../adapters/claude-code/workspace';
import { heuristicSettings, settingsRuleSource } from '../../heuristics/index';

async function main() {
  const tests: Array<[string, () => Promise<void> | void]> = [];
  const test = (name: string, fn: () => Promise<void> | void) => tests.push([name, fn]);
  const original = host();
  delete process.env.SNAGBOAT_CLAUDE_PROJECT_DIR;

  test('the default host has no folders and returns every fallback', () => {
    assert.deepStrictEqual(original.workspaceFolders(), []);
    assert.strictEqual(original.get('snagboat', 'copilot.otlpPort', 4318), 4318);
    assert.deepStrictEqual(original.section('snagboat.heuristics.loop'), {});
    assert.deepStrictEqual(resolveWorkspaceFolders(), []);
    assert.strictEqual(resolveProjectDir(), undefined);
  });

  test('engine reads go through the installed host', () => {
    const reads: string[] = [];
    const fake: Host = {
      section: (section) => (section === 'snagboat.heuristics.toolChurn' ? { threshold: 7 } : {}),
      get: <T>(section: string, key: string, fallback: T, scope?: string): T => {
        reads.push(`${section}/${key}@${scope ?? ''}`);
        if (key === 'claudeCode.configureHooks') return (scope !== '/b') as unknown as T;
        if (key === 'rules') return [{ id: 'r1' }] as unknown as T;
        return fallback;
      },
      workspaceFolders: () => ['/a', '/b'],
      onWorkspaceFoldersChanged: () => ({ dispose: () => undefined }),
      onSettingChanged: () => ({ dispose: () => undefined }),
    };
    setHost(fake);
    try {
      assert.deepStrictEqual(resolveWorkspaceFolders(), ['/a', '/b']);
      assert.strictEqual(resolveProjectDir(), '/a');
      assert.strictEqual(hooksEnabledFor('/a'), true);
      assert.strictEqual(hooksEnabledFor('/b'), false);
      assert.deepStrictEqual(heuristicSettings('tool-churn'), { threshold: 7 });
      assert.deepStrictEqual(heuristicSettings('rule:x'), {});
      assert.deepStrictEqual(settingsRuleSource(), { origin: 'settings', rules: [{ id: 'r1' }], categories: [] });
      assert.ok(reads.includes('snagboat/claudeCode.configureHooks@/b'));
    } finally {
      setHost(original);
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
