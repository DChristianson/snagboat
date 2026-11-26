import type { Match, Rule } from '../types';
import { spans } from './util';

/** .env-style NAME=<s>, NAME ending in KEY, TOKEN, SECRET, PASSWORD, PASS, PWD or CREDENTIALS. */
const ENV_LINE = /(?<![A-Za-z0-9_])[A-Z][A-Z0-9_]*?(?:KEY|TOKEN|SECRET|PASSWORD|PASS|PWD|CREDENTIALS)=(?!\[redacted\])(?<s>"[^"\n]*"|'[^'\n]*'|[^\s"'\n]+)/g;

export const envValue: Rule = {
  id: 'env-value',
  category: 'Credentials',
  describe: '`.env`-style values: `NAME=value` where the name ends in KEY, TOKEN, SECRET, PASSWORD, PASS, PWD or CREDENTIALS.',
  becomes: '`[secret]`',
  defaultAction: 'review',
  detect(text: string): Match[] {
    return spans(ENV_LINE, text);
  },
  replace(): string {
    return '[secret]';
  },
};
