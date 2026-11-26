import { buildPeople } from './people';
import type { FilterContext, Person } from './types';

/** What makeContext takes: what the caller knows about the project, as plain values. */
export interface ContextInput {
  projectRoot?: string;
  worktrees?: string[];
  matchPaths?: string[];
  /** This machine's home folder, and any other to find as written. */
  homes?: string[];
  /** Idents ("Name <email>") and bare names the records name; agents are left out. */
  people?: string[];
  /** More names to treat as agents, beside the built-in ones. */
  agentNames?: string[];
  /** Full SHAs of the repository's commits. */
  commits?: string[];
  /** The repository's names, for links into it; default the project's and worktrees' folder names. */
  repositoryNames?: string[];
  deny?: string[];
}

const stripSlash = (p: string) => (p.length > 1 ? p.replace(/[/\\]+$/, '') : p);
const baseName = (p: string) => stripSlash(p).split(/[/\\]/).pop() ?? '';

/** A FilterContext, with its lookups built once. */
export function makeContext(input: ContextInput = {}): FilterContext {
  const projectRoot = stripSlash(input.projectRoot ?? '');
  const worktrees = (input.worktrees ?? []).map(stripSlash);
  const full = new Set<string>();
  const byPrefix = new Map<string, string[]>();
  for (const sha of input.commits ?? []) {
    const s = sha.toLowerCase();
    if (!/^[0-9a-f]{40}$/.test(s) || full.has(s)) continue;
    full.add(s);
    const p = s.slice(0, 7);
    byPrefix.set(p, [...(byPrefix.get(p) ?? []), s]);
  }
  const people = buildPeople(input.people ?? [], input.agentNames);
  const personByForm = new Map<string, Person>();
  for (const person of people) {
    for (const n of person.names) personByForm.set(n.toLowerCase(), person);
    for (const l of person.logins) if (!personByForm.has(l.toLowerCase())) personByForm.set(l.toLowerCase(), person);
    for (const e of person.emails) {
      personByForm.set(e.toLowerCase(), person);
      for (const n of person.names) personByForm.set(`${n} <${e}>`.toLowerCase(), person);
    }
  }
  return {
    projectRoot,
    worktrees,
    matchPaths: (input.matchPaths ?? []).map(stripSlash),
    homes: (input.homes ?? []).map(stripSlash).filter((h) => h.length > 1),
    people,
    repositoryNames: (input.repositoryNames ?? [projectRoot, ...worktrees].filter((p) => p).map(baseName)).map((n) => n.replace(/\.git$/i, '').toLowerCase()).filter((n) => n),
    deny: (input.deny ?? []).map((w) => w.trim()).filter((w) => w.length > 0),
    resolveCommit(hex: string): string | undefined {
      const s = hex.toLowerCase();
      if (s.length < 7 || s.length > 40) return undefined;
      if (s.length === 40) return full.has(s) ? s : undefined;
      // Ambiguous prefixes resolve to the first commit given: still a known commit, never an unknown one.
      return (byPrefix.get(s.slice(0, 7)) ?? []).find((f) => f.startsWith(s));
    },
    personByForm,
  };
}
