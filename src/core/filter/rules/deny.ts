import type { FilterContext, Match, Rule } from '../types';
import { numbered, spans, wordPattern } from './util';

export const deny: Rule = {
  id: 'deny',
  category: 'Entities',
  describe: 'The words and phrases in the `export.deny` setting (a client\'s name, a codename), as whole words, ignoring case.',
  becomes: '`[denied-N]`',
  // Listing a word already says what you want done with it.
  defaultAction: 'rewrite',
  detect(text: string, ctx: FilterContext): Match[] {
    return ctx.deny.flatMap((word) => spans(wordPattern(word), text, () => word));
  },
  replace: numbered('denied'),
};
