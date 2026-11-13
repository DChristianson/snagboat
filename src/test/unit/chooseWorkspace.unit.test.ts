import * as assert from 'assert';
import { WORKSPACE_NO_FOLDER } from '@snagboat/schema';
import { chooseWorkspace } from '../../core/userStore';

async function main() {
  const tests: Array<[string, () => void]> = [];
  const test = (name: string, fn: () => void) => tests.push([name, fn]);
  const folder = '/Users/me/code/snagboat';
  const remote = 'vscode-remote://dev-container%2B1234/Users/me/code/snagboat';

  test('a local window keeps what its storage names', () => {
    assert.deepStrictEqual(chooseWorkspace({ workspace: folder, folder }, { folder: '/elsewhere' }), { workspace: folder, folder });
    assert.deepStrictEqual(chooseWorkspace({ workspace: WORKSPACE_NO_FOLDER }, { folder }), { workspace: WORKSPACE_NO_FOLDER });
  });

  test('a remote window whose folder is on this disk is the same workspace as a local window on it', () => {
    assert.deepStrictEqual(chooseWorkspace({ workspace: remote }, { folder }), { workspace: folder, folder });
    const file = '/Users/me/code/snagboat.code-workspace';
    assert.deepStrictEqual(chooseWorkspace({ workspace: remote }, { workspaceFile: file, folder }), { workspace: file, workspaceFile: file });
  });

  test('a remote window whose folder is not on this disk keeps its URI', () => {
    assert.deepStrictEqual(chooseWorkspace({ workspace: remote }, undefined), { workspace: remote });
  });

  test('with no storage to read, the window paths name it', () => {
    assert.deepStrictEqual(chooseWorkspace(undefined, { folder }), { workspace: folder, folder });
    assert.deepStrictEqual(chooseWorkspace(undefined, undefined), { workspace: WORKSPACE_NO_FOLDER });
  });

  let failures = 0;
  for (const [name, fn] of tests) {
    try {
      fn();
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
