import { isAgentEmail } from '../people';
import type { Match, Rule } from '../types';
import { numbered, spans } from './util';

const EMAIL = /(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}(?![A-Za-z0-9-])/g;

export const email: Rule = {
  id: 'email',
  category: 'Entities',
  describe: "Email addresses (`users.noreply.github.com` ones too, which name a GitHub account), except agents' and bots' (`noreply@anthropic.com`).",
  becomes: '`[email-N]`',
  defaultAction: 'review',
  detect(text: string): Match[] {
    if (!text.includes('@')) return [];
    return spans(EMAIL, text, (s) => (isAgentEmail(s) ? undefined : s.toLowerCase()));
  },
  replace: numbered('email'),
};
