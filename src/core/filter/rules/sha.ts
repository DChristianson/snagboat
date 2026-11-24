import type { FilterContext, Match, Rule } from '../types';
import { numbered, SHA_LIKE, spans } from './util';

export const sha: Rule = {
  id: 'sha',
  category: 'Repository',
  describe: "The repository's commit SHAs, whole or 7 or more characters, from everything the store knows about it, not just the export's range. A short SHA is the same value as the whole one.",
  becomes: '`[commit-N]`',
  // A repository's own SHAs are what join an export to its history.
  defaultAction: 'keep',
  detect(text: string, ctx: FilterContext): Match[] {
    return spans(SHA_LIKE, text, (s) => ctx.resolveCommit(s));
  },
  replace: numbered('commit'),
};
