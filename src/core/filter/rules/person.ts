import type { FilterContext, Match, Rule } from '../types';
import { escapeRegExp, numbered, spans, wordSource } from './util';

// The pattern for a context's people, built once per context.
const patterns = new WeakMap<FilterContext, RegExp | null>();

/** Every form of every person, longest first: "Name <email>", emails, names and logins (3+ characters). */
function pattern(ctx: FilterContext): RegExp | null {
  let re = patterns.get(ctx);
  if (re === undefined) {
    const forms = [...ctx.personByForm.keys()].filter((f) => f.length >= 3).sort((a, b) => b.length - a.length);
    // Whitespace in a name or ident matches any run of it ("Robin  Exampleton").
    re = forms.length === 0 ? null : new RegExp(wordSource(forms.map((f) => escapeRegExp(f).replace(/ +/g, '\\s+')).join('|')), 'giu');
    patterns.set(ctx, re);
  }
  return re;
}

export const person: Rule = {
  id: 'person',
  category: 'Entities',
  describe:
    'The people the records name (git authors, committers and co-authors, `Co-Authored-By` trailers, bd owners, creators, assignees and actors), by name, email or GitHub login, `@mentions` included. Every form of one person is one value. Agents and bots aren\'t people.',
  becomes: '`[person-N]`',
  defaultAction: 'review',
  detect(text: string, ctx: FilterContext): Match[] {
    const re = pattern(ctx);
    if (!re) return [];
    return spans(re, text, (s) => ctx.personByForm.get(s.replace(/\s+/g, ' ').toLowerCase())?.display);
  },
  replace: numbered('person'),
};
