import * as assert from 'assert';
import { deny } from '../../core/filter/rules/deny';
import { found, findsNothing, j, rewritten, run } from './filterHarness';

const DENY = j('Blue', 'fin');

run([
  ['a denied word becomes [denied-N], as a whole word, ignoring case; rewritten by default', () => {
    assert.strictEqual(rewritten(`The ${DENY} client; ${DENY.toLowerCase()}'s app`, { deny: [DENY, 'Project X'] }, [deny]), "The [denied-1] client; [denied-1]'s app");
    assert.strictEqual(rewritten('ship project  x? project x!', { deny: ['Project X'] }, [deny]), 'ship project  x? [denied-1]!');
    assert.strictEqual(deny.defaultAction, 'rewrite');
  }],
  ['the value is the word as listed', () => {
    assert.deepStrictEqual(found(deny, DENY.toUpperCase(), { deny: [DENY] }), [[DENY.toUpperCase(), DENY]]);
  }],
  ['not inside a longer word, and nothing with no words listed', () => {
    findsNothing(deny, [`${DENY}s and Super${DENY}`], { deny: [DENY] });
    findsNothing(deny, [DENY], {});
  }],
]);
