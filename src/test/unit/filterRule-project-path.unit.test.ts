import * as assert from 'assert';
import { projectPath } from '../../core/filter/rules/project-path';
import { found, j, rewritten, run } from './filterHarness';

const HOME = j('/home/', 'qz', 'user');
const PROJECT = j(HOME, '/work/', 'acme-app');
const WT_INSIDE = j(PROJECT, '/.claude/worktrees/', 'agent-1');
const WT_OUTSIDE = j(HOME, '/work/', 'acme-app-wt2');
const MATCH = j('/workspaces/', 'acme-app');
const ctx = { projectRoot: PROJECT, worktrees: [WT_INSIDE, WT_OUTSIDE], matchPaths: [MATCH] };

run([
  ['the project becomes ., its worktrees [worktree-N], --match paths [match-N]', () => {
    const text = `Read ${PROJECT}/src/app.ts and ${WT_INSIDE}/src/wt.ts and ${WT_OUTSIDE}/lib/x.py. Also ${MATCH}/src/in-container.ts`;
    assert.strictEqual(
      rewritten(text, ctx, [projectPath]),
      'Read ./src/app.ts and [worktree-1]/src/wt.ts and [worktree-2]/lib/x.py. Also [match-1]/src/in-container.ts'
    );
  }],
  ['the root alone, in a command, and in a file:// URL', () => {
    assert.strictEqual(rewritten(`cd ${PROJECT} && git show`, ctx, [projectPath]), 'cd . && git show');
    assert.strictEqual(rewritten(`open file://${PROJECT}/README.md`, ctx, [projectPath]), 'open ./README.md');
    assert.strictEqual(rewritten(`"${PROJECT}"`, ctx, [projectPath]), '"."');
  }],
  ['the value is the root, whatever path is under it', () => {
    assert.deepStrictEqual(found(projectPath, `${PROJECT}/a ${PROJECT}/b`, ctx).map(([, v]) => v), [PROJECT, PROJECT]);
  }],
  ['not a longer name that starts with the root, nor the root inside another path', () => {
    assert.deepStrictEqual(found(projectPath, `${PROJECT}-old/x /mnt${PROJECT}/y`, { projectRoot: PROJECT }), []);
  }],
  ['a worktree inside the project is its own value, nesting the project', () => {
    const f = found(projectPath, `${WT_INSIDE}/src`, ctx);
    assert.deepStrictEqual(f.map(([, v]) => v).sort(), [PROJECT, WT_INSIDE].sort());
  }],
]);
