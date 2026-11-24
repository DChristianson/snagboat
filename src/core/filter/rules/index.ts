import type { Rule } from '../types';
import { card } from './card';
import { connectionString } from './connection-string';
import { deny } from './deny';
import { email } from './email';
import { envValue } from './env-value';
import { highEntropy } from './high-entropy';
import { homePath } from './home-path';
import { internalHost } from './internal-host';
import { ip } from './ip';
import { mac } from './mac';
import { person } from './person';
import { phone } from './phone';
import { projectPath } from './project-path';
import { publicKey } from './public-key';
import { remote } from './remote';
import { secret } from './secret';
import { sha } from './sha';
import { unknownHex } from './unknown-hex';

/**
 * Every rule, in the rule table's order (by category). The order matters only for two rules
 * finding exactly the same span: the one listed first is the outer one.
 */
export const RULES: readonly Rule[] = [
  projectPath,
  homePath,
  secret,
  publicKey,
  connectionString,
  envValue,
  person,
  email,
  phone,
  deny,
  ip,
  mac,
  internalHost,
  sha,
  remote,
  highEntropy,
  unknownHex,
  card,
];

export function ruleById(id: string): Rule | undefined {
  return RULES.find((r) => r.id === id);
}
