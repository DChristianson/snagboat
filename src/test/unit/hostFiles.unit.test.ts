import * as assert from 'assert';
import * as path from 'path';
import { hostFileRef } from '../../vscode/hostFiles';

async function main() {
  const tests: Array<[string, () => void]> = [];
  const test = (name: string, fn: () => void) => tests.push([name, fn]);
  const root = path.resolve('/Users/me/code/snagboat');
  const other = path.resolve('/Users/me/code/other');
  const home = path.resolve('/Users/me/.snagboat/reviews/week.md');

  test('a local window opens every file as a plain file URI', () => {
    assert.deepStrictEqual(hostFileRef(path.join(root, 'src', 'a.ts'), false, [root]), { kind: 'file' });
    assert.deepStrictEqual(hostFileRef(home, false, [root]), { kind: 'file' });
  });

  test('a remote window opens workspace files through their folder', () => {
    assert.deepStrictEqual(hostFileRef(path.join(other, 'src', 'a.ts'), true, [root, other]), { kind: 'folder', folder: 1, relative: ['src', 'a.ts'] });
    assert.deepStrictEqual(hostFileRef(root, true, [root]), { kind: 'folder', folder: 0, relative: [] });
  });

  test('a remote window opens files outside its folders from the host', () => {
    assert.deepStrictEqual(hostFileRef(home, true, [root]), { kind: 'host' });
    // A sibling whose name starts with the folder's isn't inside it.
    assert.deepStrictEqual(hostFileRef(root + '-old/a.ts', true, [root]), { kind: 'host' });
    assert.deepStrictEqual(hostFileRef(path.join(root, '..', 'x.ts'), true, [root]), { kind: 'host' });
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
