import * as assert from 'assert';
import { ip, isReportableIp } from '../../core/filter/rules/ip';
import { findsNothing, j, rewritten, run } from './filterHarness';

const IPV4 = j('10.', '20.', '30.', '40');
const IPV6 = j('2001:db8:', ':42');

run([
  ['IPv4 and IPv6 addresses become [ip-N]', () => {
    assert.strictEqual(rewritten(`Box ${IPV4} / ${IPV6}; again ${IPV4}`, {}, [ip]), 'Box [ip-1] / [ip-2]; again [ip-1]');
  }],
  ['loopback and unspecified are fine', () => {
    findsNothing(ip, ['loopback 127.0.0.1 and ::1 are fine', 'bind 0.0.0.0', '::', 'at 10:00:00', 'version 1.2.3.4.5', '3c:22:fb:01:9a:7e']);
    assert.ok(isReportableIp(IPV4) && isReportableIp(IPV6));
  }],
]);
