import type { Person } from './types';

/**
 * People and agents, for the person rule's context. An agent (claude-code, Copilot, a bot) is
 * not a person: which agent did the work is the point of an export.
 */

const BUILT_IN_AGENTS = ['claude-code', 'copilot', 'generic-fs'];

/** Whether an ident or name is an agent's: its email is a bot's, or (with no email) its name is an agent's. */
export function isAgentIdentity(name: string, email: string | undefined, extra: string[] = []): boolean {
  const n = name.trim().toLowerCase();
  if (email !== undefined && email !== '') {
    const e = email.trim().toLowerCase();
    // A GitHub app's name ends in [bot], whatever email a trailer gives it (dependabot's
    // Co-authored-by uses support@github.com): no person's account can be named that.
    if (/\[bot\]$/.test(n)) return true;
    return isAgentEmail(e);
  }
  if (BUILT_IN_AGENTS.includes(n) || n.startsWith('custom:') || /\[bot\]$/.test(n)) return true;
  if (/^(?:claude|copilot)\b/.test(n)) return true;
  return extra.some((a) => a.trim().toLowerCase() === n);
}

/** An agent's or bot's email: Anthropic's and GitHub's noreply, a [bot] account, Copilot's. */
export function isAgentEmail(email: string): boolean {
  const e = email.trim().toLowerCase();
  return (
    e === 'noreply@anthropic.com' ||
    e === 'noreply@github.com' ||
    /\[bot\]@users\.noreply\.github\.com$/.test(e) ||
    /^(?:\d+\+)?copilot@users\.noreply\.github\.com$/.test(e)
  );
}

/** Splits "Name <email>" (or a bare name, or a bare email). */
export function parseIdent(raw: string): { name: string; email?: string } {
  const m = /^\s*(.*?)\s*<([^<>]*)>\s*$/.exec(raw);
  if (m) return { name: m[1], email: m[2] };
  const bare = raw.trim();
  // A bare email (bd's owner often is one) is an email with no name.
  if (/^[^\s@<>]+@[^\s@<>]+\.[A-Za-z]{2,}$/.test(bare)) return { name: '', email: bare };
  return { name: bare };
}

const norm = (s: string) => s.trim().replace(/\s+/g, ' ').toLowerCase();

/**
 * The people a list of idents and names names, merged: the same name is the same person (a bd
 * actor named as a git ident), and an email with no name is the person a git ident with that
 * email names. Agents are left out.
 */
export function buildPeople(idents: string[], agentNames: string[] = []): Person[] {
  const byName = new Map<string, Person>();
  const byEmail = new Map<string, Person>();
  const people: Person[] = [];
  const add = (list: string[], v: string) => {
    if (!list.some((x) => norm(x) === norm(v))) list.push(v.trim());
  };
  // Whole idents first, then bare names, then bare emails, so a bd actor named by a login, or a
  // bare email, joins the person a git ident names whatever order they come in.
  const rank = (p: { name: string; email?: string }) => (p.name && p.email ? 0 : p.name ? 1 : 2);
  const parsed = idents.map(parseIdent).filter((p) => !isAgentIdentity(p.name, p.email, agentNames) && (p.name || p.email));
  parsed.sort((a, b) => rank(a) - rank(b));
  for (const { name, email } of parsed) {
    let person = (name ? byName.get(norm(name)) : undefined) ?? (email ? byEmail.get(norm(email)) : undefined);
    if (!person) {
      person = { display: name ? name.trim().replace(/\s+/g, ' ') : email!.trim(), names: [], emails: [], logins: [] };
      people.push(person);
    }
    if (name) {
      add(person.names, name.replace(/\s+/g, ' '));
      byName.set(norm(name), person);
    }
    if (email) {
      add(person.emails, email);
      byEmail.set(norm(email), person);
      const login = /^(?:\d+\+)?([^@]+)@users\.noreply\.github\.com$/i.exec(email.trim())?.[1];
      if (login) {
        add(person.logins, login);
        if (!byName.has(norm(login))) byName.set(norm(login), person);
      }
    }
  }
  return people;
}
