import * as assert from 'assert';
import { homePath } from '../../core/filter/rules/home-path';
import { found, findsNothing, j, rewritten, run } from './filterHarness';

const USER = j('qz', 'user');
const HOME = j('/home/', USER);

run([
  ['a home folder becomes ~, the rest of the path kept', () => {
    assert.strictEqual(rewritten(`then ${HOME}/Downloads/dump.csv and ${HOME}`, {}, [homePath]), 'then ~/Downloads/dump.csv and ~');
  }],
  ["anyone's home, not only this machine's: a Mac's and a container's in one store", () => {
    const text = j('/Users/', 'dave/workspace/x.ts and /home/', 'vscode/.claude/projects');
    assert.deepStrictEqual(found(homePath, text).map(([, v]) => v), [j('/Users/', 'dave'), j('/home/', 'vscode')]);
    assert.strictEqual(rewritten(text, {}, [homePath]), '~/workspace/x.ts and ~/.claude/projects');
  }],
  ['Windows, file:// URLs and ~user forms', () => {
    assert.strictEqual(rewritten(j('C:\\Users\\', USER, '\\notes.txt'), {}, [homePath]), '~\\notes.txt');
    assert.deepStrictEqual(found(homePath, j('c:/Users/', USER, '/x')).map(([, v]) => v), [j('C:\\Users\\', USER)]);
    assert.strictEqual(rewritten(`see file://${HOME}/Desktop/a.png`, {}, [homePath]), 'see ~/Desktop/a.png');
    assert.strictEqual(rewritten(j('ls ~', USER, '/bin'), {}, [homePath]), 'ls ~/bin');
  }],
  ['the value is the home folder, so every path under it is one decision', () => {
    assert.deepStrictEqual(found(homePath, `${HOME}/a ${HOME}/b/c`).map(([, v]) => v), [HOME, HOME]);
  }],
  ["this machine's home, wherever it is, as written", () => {
    const home = j('/tmp/x1/', USER);
    assert.strictEqual(rewritten(`${home}/notes/todo.md`, { homes: [home] }, [homePath]), '~/notes/todo.md');
  }],
  ['after a colon, as in an event id that names a transcript file', () => {
    assert.strictEqual(rewritten(`claude-code:${HOME}/.claude/projects/s.jsonl:123`, {}, [homePath]), 'claude-code:~/.claude/projects/s.jsonl:123');
  }],
  ['not ~/ (already relative), /Users/Shared, or /home inside a URL or another path', () => {
    findsNothing(homePath, ['~/notes/todo.md', '/Users/Shared/x', 'https://example.com/home/page', '/srv/home/x', 'home and Users']);
  }],
]);
