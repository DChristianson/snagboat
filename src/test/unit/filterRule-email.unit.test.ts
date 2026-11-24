import * as assert from 'assert';
import { email } from '../../core/filter/rules/email';
import { found, findsNothing, j, rewritten, run } from './filterHarness';

const PERSON_EMAIL = j('robin', '@', 'example.org');
const OTHER_EMAIL = j('someone.else', '@', 'mail.example.net');
const LOGIN_EMAIL = j('12345+', 'rexampleton', '@users.noreply.github.com');

run([
  ['emails become [email-N], numbered, the same value the same number', () => {
    const text = `Mail ${PERSON_EMAIL} or ${OTHER_EMAIL}; again ${PERSON_EMAIL.toUpperCase()}`;
    assert.strictEqual(rewritten(text, {}, [email]), 'Mail [email-1] or [email-2]; again [email-1]');
  }],
  ["a noreply.github.com email names an account: it's found", () => {
    assert.deepStrictEqual(found(email, `by ${LOGIN_EMAIL}`).map(([, v]) => v), [LOGIN_EMAIL]);
  }],
  ["agents' and bots' emails aren't", () => {
    findsNothing(email, ['Co-Authored-By: Claude <noreply@anthropic.com>', 'noreply@github.com', '49699333+dependabot[bot]@users.noreply.github.com', 'no at sign', '@types/node']);
  }],
]);
