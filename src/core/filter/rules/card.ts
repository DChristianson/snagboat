import type { Match, Rule } from '../types';
import { isCardNumber, numbered, spans } from './util';

/** Candidates only: the Luhn check decides. 13–19 digits, spaces or dashes between. */
const CARD = /(?<![\w.-])\d(?:[ -]?\d){12,18}(?![\w-]|\.\d)/g;

export const card: Rule = {
  id: 'card',
  category: 'Other',
  describe: 'Payment card numbers: 13 to 19 digits passing the Luhn check.',
  becomes: '`[card-N]`',
  defaultAction: 'review',
  detect(text: string): Match[] {
    return spans(CARD, text, (s) => (isCardNumber(s) ? s.replace(/[ -]/g, '') : undefined));
  },
  replace: numbered('card'),
};
