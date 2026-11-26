import * as assert from 'assert';
import { phone } from '../../core/filter/rules/phone';
import { findsNothing, j, rewritten, run } from './filterHarness';

const PHONE_INTL = j('+44 20 ', '7946 0958');
const PHONE_NA = j('(555) ', '010-0199');

run([
  ['international and North American numbers become [phone-N]', () => {
    assert.strictEqual(rewritten(`Call ${PHONE_INTL} or ${PHONE_NA} or 555.010.0199.`, {}, [phone]), 'Call [phone-1] or [phone-2] or [phone-3].');
  }],
  ['not a card number, a time offset, a date, or a short number', () => {
    findsNothing(phone, [j('4111 1111 ', '1111 1111'), '2026-11-20T15:00:00+05:00', '2026-11-20', '+1 555', 'v1.2.3']);
  }],
]);
