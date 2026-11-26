import * as assert from 'assert';
import { mac } from '../../core/filter/rules/mac';
import { found, findsNothing, j, rewritten, run } from './filterHarness';

const MAC = j('3c:22:', 'fb:01:', '9a:7e');

run([
  ['MAC addresses become [mac-N]; dashes and case are the same value', () => {
    assert.strictEqual(rewritten(`eth0 ${MAC} and ${MAC.toUpperCase().replace(/:/g, '-')}`, {}, [mac]), 'eth0 [mac-1] and [mac-1]');
    assert.deepStrictEqual(found(mac, MAC), [[MAC, MAC]]);
  }],
  ['not times, IPv6 or longer runs', () => {
    findsNothing(mac, ['10:00:00', '2001:db8::42', '3c:22:fb:01:9a:7e:11']);
  }],
]);
