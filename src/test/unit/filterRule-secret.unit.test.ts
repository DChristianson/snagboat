import * as assert from 'assert';
import { redactSecrets } from '../../core/excerpt';
import { secret, SECRET_PATTERNS } from '../../core/filter/rules/secret';
import { found, findsNothing, j, rewritten, run } from './filterHarness';

const AWS = j('AKIA', 'QZQZQZQZ', 'QZQZQZQZ');
const GH_TOKEN = j('ghp_', 'Ab1'.repeat(12));
const PRIVATE_KEY = j('-----BEGIN ', 'RSA PRIVATE KEY-----\nMIIqz', '\n-----END RSA PRIVATE KEY-----');
const PG_PW = j('pg', 'pass99x');

run([
  ['known formats become [secret]', () => {
    assert.strictEqual(rewritten(`My keys: ${AWS} and ${GH_TOKEN}.\n${PRIVATE_KEY}`, {}, [secret]), 'My keys: [secret] and [secret].\n[secret]');
  }],
  ['a kept prefix stays: Bearer, URL credentials, key=value', () => {
    assert.strictEqual(rewritten(j('Authorization: Bearer ', 'abcdefghij0123456789xyz'), {}, [secret]), 'Authorization: Bearer [secret]');
    assert.strictEqual(rewritten(`postgres://admin:${PG_PW}@db.example.com/app`, {}, [secret]), 'postgres://admin:[secret]@db.example.com/app');
    assert.strictEqual(rewritten(j('password = "', 'hunter2hunter2', '"'), {}, [secret]), 'password = "[secret]"');
  }],
  ['one value however many formats match it', () => {
    const f = found(secret, `token=${GH_TOKEN}`);
    assert.deepStrictEqual(new Set(f.map(([, v]) => v)), new Set([GH_TOKEN]));
  }],
  ['what capture already redacted is left alone; ordinary code too', () => {
    findsNothing(secret, ['[redacted AWS key] and Bearer [redacted]', 'const token = parse(x)', 'password: [redacted]']);
  }],
  ['capture-time redaction still uses the same patterns, unchanged', () => {
    assert.ok(SECRET_PATTERNS.length >= 13);
    assert.strictEqual(redactSecrets(`k ${AWS} Bearer abcdefghij0123456789xyz`), 'k [redacted AWS key] Bearer [redacted]');
    assert.strictEqual(redactSecrets(`postgres://admin:${PG_PW}@db`), 'postgres://admin:[redacted]@db');
  }],
]);
