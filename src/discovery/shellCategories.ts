import { commandPrefix, isShellTool, parseShellSubCategory, ShellSubCategory } from '../core/toolCategory';
import { NormalizedEvent } from '../core/types';

/** Commands whose second word says what they do (`npm install`, `docker run`), so families are two words. */
const TWO_WORD = new Set(['npm', 'pnpm', 'yarn', 'bun', 'pip', 'pip3', 'brew', 'cargo', 'go', 'apt', 'apt-get', 'docker', 'kubectl', 'gcloud', 'aws', 'az', 'code']);
/** A command family taking this share of plain shell calls is worth its own category. */
const MIN_SHARE = 0.1;
const MIN_CALLS = 5;
const MIN_SESSIONS = 2;

export interface ShellCandidate {
  category: ShellSubCategory;
  calls: number;
  /** Share of plain shell calls it would take. */
  share: number;
  sessions: number;
}

export interface ShellDiscovery {
  /** Plain "Shell command" calls in the history (ones a sub-category already took aren't counted). */
  shellCalls: number;
  candidates: ShellCandidate[];
  /** Share of plain shell calls the candidates would leave in "Shell command". */
  leftShare: number;
}

/** The command family a shell call belongs to: its first word, or first two for TWO_WORD commands. */
function family(command: string): string | undefined {
  const [first, second] = commandPrefix(command);
  if (!first) return undefined;
  return TWO_WORD.has(first) && second && /^[a-z][a-z0-9-]*$/.test(second) ? `${first} ${second}` : first;
}

/** Proposes sub-categories of "Shell command" from how often each command family appears. Reads command names only. */
export function discoverShellCategories(events: NormalizedEvent[]): ShellDiscovery {
  const families = new Map<string, { calls: number; sessions: Set<string> }>();
  let shellCalls = 0;
  for (const e of events) {
    if (e.kind !== 'tool_call' || e.toolCategory !== 'shell' || !isShellTool(e.toolName) || !e.target) continue;
    shellCalls += 1;
    const name = family(e.target);
    if (!name) continue;
    const f = families.get(name) ?? { calls: 0, sessions: new Set<string>() };
    f.calls += 1;
    f.sessions.add(e.sessionId);
    families.set(name, f);
  }
  const candidates: ShellCandidate[] = [];
  for (const [name, f] of families) {
    const share = f.calls / shellCalls;
    if (share < MIN_SHARE || f.calls < MIN_CALLS || f.sessions.size < MIN_SESSIONS) continue;
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const { value } = parseShellSubCategory({ id: `discovery:shell/${slug}`, parent: 'shell', label: name, match: [name] });
    if (value) candidates.push({ category: value, calls: f.calls, share, sessions: f.sessions.size });
  }
  candidates.sort((a, b) => b.calls - a.calls);
  return { shellCalls, candidates, leftShare: shellCalls === 0 ? 0 : 1 - candidates.reduce((n, c) => n + c.share, 0) };
}
