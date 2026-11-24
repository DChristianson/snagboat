import * as assert from 'assert';
import { envValue } from '../../core/filter/rules/env-value';
import { findsNothing, j, rewritten, run } from './filterHarness';

const ENV_VALUE = j('hunter', '-two');

run([
  ['NAME=value becomes NAME=[secret], whatever the value looks like', () => {
    assert.strictEqual(rewritten(`DB_PASSWORD=${ENV_VALUE}\nAPI_KEY="${ENV_VALUE} x"`, {}, [envValue]), 'DB_PASSWORD=[secret]\nAPI_KEY=[secret]');
    assert.strictEqual(rewritten(`export GITHUB_TOKEN=${ENV_VALUE}`, {}, [envValue]), 'export GITHUB_TOKEN=[secret]');
  }],
  ['not other names, lower case, or a value already redacted', () => {
    findsNothing(envValue, ['NODE_ENV=production', 'db_password=x', 'DB_PASSWORD=[redacted]', 'KEYBOARD=us']);
  }],
]);
