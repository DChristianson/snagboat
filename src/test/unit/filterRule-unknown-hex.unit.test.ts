import * as assert from 'assert';
import * as crypto from 'crypto';
import { unknownHex } from '../../core/filter/rules/unknown-hex';
import { findsNothing, j, rewritten, run } from './filterHarness';

const UNKNOWN_SHA = j('deadbeef', '12');
const KNOWN = crypto.createHash('sha1').update('commit one').digest('hex');

run([
  ['hex that might be a SHA but is no known commit becomes [hex-N]', () => {
    assert.strictEqual(rewritten(`${UNKNOWN_SHA} is unknown; so is ${UNKNOWN_SHA}`, { commits: [KNOWN] }, [unknownHex]), '[hex-1] is unknown; so is [hex-1]');
  }],
  ['not a known commit (whole or short), nor digits or letters alone, ids, or UUIDs', () => {
    findsNothing(
      unknownHex,
      [KNOWN, KNOWN.slice(0, 8), '12345678', 'deadbeef', 'abc12', `checkout-${UNKNOWN_SHA}`, '0f8fad5b-d9cb-469f-a165-70867728950e', `x${UNKNOWN_SHA}`],
      { commits: [KNOWN] }
    );
  }],
]);
