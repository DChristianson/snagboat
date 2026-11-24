import * as assert from 'assert';
import { publicKey } from '../../core/filter/rules/public-key';
import { findsNothing, j, rewritten, run } from './filterHarness';

const SSH_PUB = j('ssh-ed25519 AAAAC3NzaC1lZDI1NTE5', 'AAAAIqzqzqzqzqzqzqz', ' ', 'qzuser', '@', 'qz-laptop');
const PGP = j('-----BEGIN PGP PUBLIC KEY BLOCK-----\n', 'mQINBGqz\n', '-----END PGP PUBLIC KEY BLOCK-----');

run([
  ['an authorized_keys line, with its user@host comment, becomes [public-key]', () => {
    assert.strictEqual(rewritten(`${SSH_PUB}\nnext`, {}, [publicKey]), '[public-key]\nnext');
  }],
  ['a PGP public key block', () => {
    assert.strictEqual(rewritten(`key:\n${PGP}\ndone`, {}, [publicKey]), 'key:\n[public-key]\ndone');
  }],
  ['not the word ssh-ed25519 alone', () => {
    findsNothing(publicKey, ['use ssh-ed25519 keys', 'ssh-rsa is old']);
  }],
]);
