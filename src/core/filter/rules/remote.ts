import type { FilterContext, Match, Rule } from '../types';
import { spans } from './util';

/**
 * A link to a repository on a forge: https://github.com/<owner>/<repo>, git@github.com:<owner>/<repo>.git,
 * or github.com/<owner>/<repo> written without a scheme. The span ends at the repository's name,
 * so what follows (/pull/158) stays: [repo]/pull/158, which no longer works as a link.
 */
const FORGE_LINK =
  /(?:(?:git\+)?(?:https?|ssh|git):\/\/(?:[^@/\s]+@)?|(?<![\w./@-])[A-Za-z0-9._-]+@|(?<![\w./@-]))(?:www\.)?(?<host>github\.com|gitlab\.com|bitbucket\.org|codeberg\.org)[/:](?<owner>[A-Za-z0-9_.-]+)\/(?<repo>[A-Za-z0-9_-]+(?:\.(?!git\b)[A-Za-z0-9_-]+)*)(?:\.git)?(?![A-Za-z0-9_-])/gi;

export const remote: Rule = {
  id: 'remote',
  category: 'Repository',
  describe: "Links into the project's own repository (`https://github.com/<owner>/<repo>`, `git@github.com:<owner>/<repo>.git`), up to the repository's name.",
  becomes: '`[repo]`',
  defaultAction: 'keep',
  detect(text: string, ctx: FilterContext): Match[] {
    if (ctx.repositoryNames.length === 0 || !/github|gitlab|bitbucket|codeberg/i.test(text)) return [];
    return spans(FORGE_LINK, text, (_s, m) => {
      const { host, owner, repo } = m.groups!;
      return ctx.repositoryNames.includes(repo.toLowerCase()) ? `${host}/${owner}/${repo}`.toLowerCase() : undefined;
    });
  },
  replace(): string {
    return '[repo]';
  },
};
