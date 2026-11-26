/**
 * The privacy filter's types (docs/design/export.md, "The privacy filter"). The filter knows
 * nothing about exports: callers hand it strings and a FilterContext, and write back what it
 * returns.
 */

/** What happens to a rule's values. review: you decide each; rewrite and keep: unless you decided otherwise; off: the rule doesn't run. */
export type Action = 'review' | 'rewrite' | 'keep' | 'off';

/** A decision on one value. */
export type Decision = 'rewrite' | 'keep';

export const ACTIONS: readonly Action[] = ['review', 'rewrite', 'keep', 'off'];

/** The rule table's groups, in the order it lists them. */
export const CATEGORIES = ['Local directories', 'Credentials', 'Entities', 'Network', 'Repository', 'Other'] as const;
export type Category = (typeof CATEGORIES)[number];

/**
 * One value a rule found: where in the ORIGINAL text, and the value you decide on. The value
 * isn't always the text matched: every form of one person is the person's name, a short SHA
 * is the full SHA, a home path is its home folder.
 */
export interface Match {
  start: number;
  end: number;
  value: string;
}

export interface Rule {
  /** Its id, as settings, --rule, decisions and the manifest name it: 'email'. */
  id: string;
  category: Category;
  /** What it finds, one or two sentences, for the generated rule table. */
  describe: string;
  /** What a rewritten value reads as, for the rule table: '[email-N]'. */
  becomes: string;
  defaultAction: Action;
  /** Its values in text. Sees only the original text, never another rule's output. */
  detect(text: string, ctx: FilterContext): Match[];
  /** The placeholder for a rewritten value, the nth this rule rewrote in this run (from 1). */
  replace(value: string, n: number, ctx: FilterContext): string;
}

/** A person the records name, and every form they're written in. */
export interface Person {
  /** What review shows and decisions key on: their name, else their email. */
  display: string;
  names: string[];
  emails: string[];
  /** GitHub logins, from users.noreply.github.com emails. */
  logins: string[];
}

/** What the caller knows about the project. Build it with makeContext (context.ts). */
export interface FilterContext {
  /** The project's root, absolute; '' when there's none. */
  projectRoot: string;
  /** The repository's other worktrees, absolute, in a stable order: [worktree-1], [worktree-2]. */
  worktrees: string[];
  /** --match paths, absolute: [match-1], [match-2]. */
  matchPaths: string[];
  /** Home folders to find as written, beside /Users/<name> and the like: this machine's, wherever it is. */
  homes: string[];
  /** The people the records name (agents left out). */
  people: Person[];
  /** The repository's names (its folders' names), for links into it. Lower case. */
  repositoryNames: string[];
  /** export.deny: words and phrases. */
  deny: string[];
  /** The full SHA a hex string (7–40 characters, lower case) abbreviates, if it's a commit the repository has. */
  resolveCommit(hex: string): string | undefined;
  /** The person a form (a name, email, login or ident) names, by its lower-cased text. */
  personByForm: Map<string, Person>;
}
