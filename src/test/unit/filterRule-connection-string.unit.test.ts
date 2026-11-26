import * as assert from 'assert';
import { connectionString } from '../../core/filter/rules/connection-string';
import { found, findsNothing, j, rewritten, run } from './filterHarness';

const CONN_PW = j('S3cret', 'pw');

run([
  ["a semicolon connection string's password becomes [secret]", () => {
    assert.strictEqual(rewritten(`Server=db;Database=app;Password=${CONN_PW};`, {}, [connectionString]), 'Server=db;Database=app;Password=[secret];');
    assert.strictEqual(rewritten(`Server=db;Pwd = ${CONN_PW}`, {}, [connectionString]), 'Server=db;Pwd = [secret]');
  }],
  ['the value is the password, trimmed', () => {
    assert.deepStrictEqual(found(connectionString, `Password=${CONN_PW} ;x`), [[CONN_PW, CONN_PW]]);
  }],
  ['not one already redacted, nor a password word in prose', () => {
    findsNothing(connectionString, ['Password=[redacted];', 'the password is long']);
  }],
]);
