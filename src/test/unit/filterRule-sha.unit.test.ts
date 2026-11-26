import * as assert from 'assert';
import * as crypto from 'crypto';
import { sha } from '../../core/filter/rules/sha';
import { found, findsNothing, rewritten, run } from './filterHarness';

const SHA1 = crypto.createHash('sha1').update('commit one').digest('hex');
const SHA2 = crypto.createHash('sha1').update('commit two').digest('hex');
const UNKNOWN = crypto.createHash('sha1').update('not a commit').digest('hex');
const ctx = { commits: [SHA1, SHA2] };

run([
  ["a known commit's SHA, whole or short, is the one value, the whole SHA", () => {
    assert.deepStrictEqual(found(sha, `Reverts ${SHA1.slice(0, 7)}; see ${SHA1} and outcome:milestone:${SHA2}`, ctx).map(([, v]) => v), [SHA1, SHA1, SHA2]);
  }],
  ['rewritten, it becomes [commit-N], the same N for its short form', () => {
    assert.strictEqual(rewritten(`git show ${SHA2}; ${SHA2.slice(0, 9)}; ${SHA1}`, ctx, [sha]), 'git show [commit-1]; [commit-1]; [commit-2]');
  }],
  ["kept by default: a repository's own SHAs join the export to its history", () => {
    assert.strictEqual(sha.defaultAction, 'keep');
  }],
  ['not unknown hex, too short a prefix, upper case, or inside an id', () => {
    findsNothing(sha, [UNKNOWN, SHA1.slice(0, 6), SHA1.toUpperCase(), `checkout-${SHA1.slice(0, 16)}`, `x${SHA1}`], ctx);
  }],
]);
