import * as assert from 'assert';
import { remote } from '../../core/filter/rules/remote';
import { found, findsNothing, j, rewritten, run } from './filterHarness';

const LOGIN = j('rex', 'ampleton');
const PROJECT = j('/home/qz', 'user/work/acme-app');
const ctx = { projectRoot: PROJECT };

run([
  ["a link into the project's repository becomes [repo], what follows kept", () => {
    const text = [
      `PR https://github.com/${LOGIN}/acme-app/pull/158).`,
      `doc https://github.com/${LOGIN}/acme-app/blob/main/docs/cli.md#export and git+https://github.com/${LOGIN}/acme-app.git`,
      `remote git@github.com:${LOGIN}/acme-app.git and github.com/${LOGIN}/acme-app`,
    ].join('\n');
    assert.strictEqual(
      rewritten(text, ctx, [remote]),
      ['PR [repo]/pull/158).', 'doc [repo]/blob/main/docs/cli.md#export and [repo]', 'remote [repo] and [repo]'].join('\n')
    );
  }],
  ['the value is host/owner/repo, the same however the link is written', () => {
    const f = found(remote, `https://github.com/${LOGIN}/acme-app/pull/1 git@github.com:${LOGIN}/acme-app.git`, ctx);
    assert.deepStrictEqual(new Set(f.map(([, v]) => v)), new Set([`github.com/${LOGIN}/acme-app`]));
    assert.strictEqual(remote.defaultAction, 'keep');
  }],
  ['the repository names can be given; other repositories are left alone', () => {
    assert.strictEqual(rewritten('https://gitlab.com/o/widget/-/issues/3', { repositoryNames: ['widget'] }, [remote]), '[repo]/-/issues/3');
    findsNothing(remote, [`https://github.com/${LOGIN}/other-repo/pull/31`, 'https://github.com/microsoft/vscode/issues/123', `https://github.com/${LOGIN}/acme-app-old`], ctx);
  }],
]);
