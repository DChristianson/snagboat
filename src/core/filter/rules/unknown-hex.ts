import type { FilterContext, Match, Rule } from '../types';
import { isShaLike, numbered, SHA_LIKE, spans } from './util';

export const unknownHex: Rule = {
  id: 'unknown-hex',
  category: 'Other',
  describe: 'Runs of 7 to 40 lower-case hex characters, a letter and a digit both, that might be a commit SHA but match no commit the store knows.',
  becomes: '`[hex-N]`',
  defaultAction: 'review',
  detect(text: string, ctx: FilterContext): Match[] {
    return spans(SHA_LIKE, text, (s) => (isShaLike(s) && !ctx.resolveCommit(s) ? s : undefined));
  },
  replace: numbered('hex'),
};
