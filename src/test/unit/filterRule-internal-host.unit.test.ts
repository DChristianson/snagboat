import * as assert from 'assert';
import { internalHost } from '../../core/filter/rules/internal-host';
import { found, findsNothing, j, rewritten, run } from './filterHarness';

const INTERNAL_URL = j('http://build-box', '.internal:8080/jobs/7');
const HOST = j('qz', '-laptop', '.local');

run([
  ["a URL's internal host becomes [host-N]; the URL stops being a working link", () => {
    assert.strictEqual(rewritten(`CI at ${INTERNAL_URL} and http://buildbox/x`, {}, [internalHost]), 'CI at http://[host-1]:8080/jobs/7 and http://[host-2]/x');
  }],
  ['a bare internal host name, outside a URL', () => {
    assert.deepStrictEqual(found(internalHost, `on ${HOST}.`).map(([, v]) => v), [HOST]);
    assert.deepStrictEqual(found(internalHost, `ssh dev@${HOST}`).map(([, v]) => v), [], 'inside an email, the email is the value');
  }],
  ['the same host in a URL and bare is one value', () => {
    const f = found(internalHost, `${INTERNAL_URL} build-box.internal`);
    assert.deepStrictEqual(new Set(f.map(([, v]) => v)), new Set(['build-box.internal']));
  }],
  ['public hosts, localhost and code are fine', () => {
    findsNothing(internalHost, ['http://localhost:3000/ok', 'https://github.com/microsoft/vscode', 'this.private and config.home', 'http://10.0.0.1/', 'svc.localhost']);
  }],
]);
