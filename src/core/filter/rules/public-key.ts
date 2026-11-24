import type { Match, Rule } from '../types';
import { spans } from './util';

/** SSH and PGP public key blocks, and authorized_keys / .pub lines (with their user@host comment). */
const PATTERNS: RegExp[] = [
  /-----BEGIN (?:SSH2 |PGP |RSA )?PUBLIC KEY(?: BLOCK)?-----[\s\S]*?(?:-----END (?:SSH2 |PGP |RSA )?PUBLIC KEY(?: BLOCK)?-----|$)/g,
  /\b(?:ssh-(?:rsa|ed25519|dss)|ecdsa-sha2-nistp\d+|sk-(?:ssh-ed25519|ecdsa-sha2-nistp256)@openssh\.com)[ \t]+AAAA[A-Za-z0-9+/]+={0,3}(?:[ \t]+[^\s"'`]+)?/g,
];

export const publicKey: Rule = {
  id: 'public-key',
  category: 'Credentials',
  describe: 'SSH and PGP public key blocks, and `authorized_keys` lines. Not secret, but they identify a person.',
  becomes: '`[public-key]`',
  defaultAction: 'review',
  detect(text: string): Match[] {
    return PATTERNS.flatMap((p) => spans(p, text));
  },
  replace(): string {
    return '[public-key]';
  },
};
