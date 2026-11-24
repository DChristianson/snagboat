import type { Match, Rule } from '../types';
import { isCardNumber, numbered, spans } from './util';

const PATTERNS: RegExp[] = [
  // International: +44 20 7946 0958, +1-555-010-0199.
  /(?<![\w+])\+\d{1,3}(?:[ .-]?\(?\d{1,4}\)?){2,5}(?![\w])/g,
  // North American: (555) 010-0199, 555-010-0199, 555.010.0199.
  /(?<![\w-])(?:\(\d{3}\)[ ]?|\d{3}[-. ])\d{3}[-. ]\d{4}(?![\w-])/g,
];

/** A plausible number of digits, and not a card number. */
const isPhone = (s: string) => {
  const n = s.replace(/\D/g, '').length;
  return n >= 10 && n <= 15 && !isCardNumber(s);
};

export const phone: Rule = {
  id: 'phone',
  category: 'Entities',
  describe: 'Phone numbers in international or North American form.',
  becomes: '`[phone-N]`',
  defaultAction: 'review',
  detect(text: string): Match[] {
    return PATTERNS.flatMap((p) => spans(p, text, (s) => (isPhone(s) ? s : undefined)));
  },
  replace: numbered('phone'),
};
