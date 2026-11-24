import * as assert from 'assert';
import * as crypto from 'crypto';
import { highEntropy, isHighEntropy } from '../../core/filter/rules/high-entropy';
import { findsNothing, rewritten, run } from './filterHarness';

const HIGH_ENTROPY = crypto.createHash('sha512').update('made-up seed').digest('base64').replace(/[+/=]/g, 'x').slice(0, 48);
const LONG_HEX = crypto.createHash('sha256').update('x').digest('hex');

run([
  ['a long high-entropy token becomes [token-N]', () => {
    assert.strictEqual(rewritten(`Blob ${HIGH_ENTROPY}.`, {}, [highEntropy]), 'Blob [token-1].');
    assert.strictEqual(rewritten(`hex ${LONG_HEX}`, {}, [highEntropy]), 'hex [token-1]');
  }],
  ['at the end of a URL path only the token, so the host stays readable', () => {
    assert.strictEqual(rewritten(`session https://claude.ai/code/${HIGH_ENTROPY}`, {}, [highEntropy]), 'session https://claude.ai/code/[token-1]');
  }],
  ['not a SHA (40 hex), identifiers, words, or short tokens', () => {
    findsNothing(highEntropy, [
      crypto.createHash('sha1').update('c').digest('hex'),
      'this_is_a_very_long_snake_case_identifier_name_number_1',
      'src/core/filter/rules/high-entropy-and-more-words.ts',
      'abc123',
    ]);
    assert.ok(isHighEntropy(HIGH_ENTROPY) && !isHighEntropy('a'.repeat(60)));
  }],
]);
