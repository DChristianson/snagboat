import * as assert from 'assert';
import { card } from '../../core/filter/rules/card';
import { found, findsNothing, j, rewritten, run } from './filterHarness';

const CARD = j('4111 1111 ', '1111 1111');

run([
  ['a number passing the Luhn check becomes [card-N]; separators are the same value', () => {
    assert.strictEqual(rewritten(`Card ${CARD}.`, {}, [card]), 'Card [card-1].');
    assert.deepStrictEqual(found(card, CARD.replace(/ /g, '-')).map(([, v]) => v), [CARD.replace(/ /g, '')]);
  }],
  ['not one failing the check, repeated digits, a time in milliseconds inside a word, or a version', () => {
    findsNothing(card, [j('4111 1111 ', '1111 1112'), '0000000000000000', 'ts1700000000000x', '1.2.3']);
  }],
]);
