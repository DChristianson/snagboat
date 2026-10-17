import { Heuristic, Finding, HeuristicContext } from './types';
import { NormalizedEvent } from '../core/types';

const DEFAULT_WINDOW_MINUTES = 10;
const DEFAULT_MIN_TURNS = 2;
// A target touched this often in the window, or any failed tool call, counts
// as the behavioral signal that lets a hedge finding escalate to a warning.
const PAIRED_REPEAT_THRESHOLD = 3;

// Each pattern is labelled with the phrase shown in the finding. Kept to
// multi-word or punctuated forms where a bare word ("actually", "wait") would
// match ordinary prose far too often.
const HEDGE_PATTERNS: Array<[label: string, pattern: RegExp]> = [
  ['I think', /\bI think\b/i],
  ['I believe', /\bI believe\b/i],
  ['should work', /\bshould (?:now )?work\b/i],
  ['might work', /\bmight (?:work|fix|help)\b/i],
  ['not sure', /\bnot (?:entirely )?sure\b/i],
  ['let me try', /\blet me try\b/i],
  ['try again', /\btry (?:that )?again\b/i],
  ['different approach', /\b(?:a |another |different )approach\b/i],
  ['actually,', /\bactually,/i],
  ['wait,', /\bwait,/i],
  ['my mistake', /\bmy (?:mistake|bad|apologies)\b/i],
  ['I apologize', /\bI apologi[sz]e\b/i],
  ['sorry', /\bsorry\b/i],
  ['I was wrong', /\bI was (?:wrong|mistaken)\b/i],
  ["that didn't work", /\b(?:that|this|it) (?:didn't|did not|doesn't|does not) (?:work|fix)\b/i],
  ['I made an error', /\bI made (?:an? )?(?:error|mistake)\b/i],
];

/** Labels of every hedge/self-correction pattern found in text, in pattern order. */
export function findHedges(text: string): string[] {
  return HEDGE_PATTERNS.filter(([, pattern]) => pattern.test(text)).map(([label]) => label);
}

function positiveNumberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && value > 0 ? value : fallback;
}

/** Whether a session's tool/edit activity in the window shows looping or failure. */
function hasBehavioralSignal(events: NormalizedEvent[]): boolean {
  const counts = new Map<string, number>();
  for (const event of events) {
    if (event.kind === 'tool_call' && event.status === 'failure') return true;
    if (!event.target) continue;
    const n = (counts.get(event.target) ?? 0) + 1;
    if (n >= PAIRED_REPEAT_THRESHOLD) return true;
    counts.set(event.target, n);
  }
  return false;
}

/**
 * Flags sessions whose recent replies repeatedly hedge or self-correct. Reads
 * only textExcerpt, so it is silent unless snagboat.captureContent is on.
 * Informational on its own; escalates to a warning only when the same session
 * also shows a behavioral signal in the window (docs/heuristics.md).
 */
export const verbalHedgeHeuristic: Heuristic = {
  id: 'verbal-hedge',
  appliesTo: ['turn_stop', 'tool_call', 'edit'],

  evaluate(ctx: HeuristicContext): Finding[] {
    const windowMinutes = positiveNumberOr(ctx.settings.window, DEFAULT_WINDOW_MINUTES);
    const minTurns = positiveNumberOr(ctx.settings.minTurns, DEFAULT_MIN_TURNS);
    const since = new Date(new Date(ctx.now).getTime() - windowMinutes * 60_000).toISOString();

    const bySession = new Map<string, { hedged: NormalizedEvent[]; phrases: Set<string>; activity: NormalizedEvent[] }>();
    const session = (id: string) => {
      let s = bySession.get(id);
      if (!s) {
        s = { hedged: [], phrases: new Set(), activity: [] };
        bySession.set(id, s);
      }
      return s;
    };

    for (const event of ctx.store.query({ since })) {
      if (event.kind === 'turn_stop') {
        if (!event.textExcerpt) continue;
        const hedges = findHedges(event.textExcerpt);
        if (hedges.length === 0) continue;
        const s = session(event.sessionId);
        s.hedged.push(event);
        for (const h of hedges) s.phrases.add(h);
      } else if (event.kind === 'tool_call' || event.kind === 'edit') {
        session(event.sessionId).activity.push(event);
      }
    }

    const findings: Finding[] = [];
    for (const [sessionId, s] of bySession) {
      if (s.hedged.length < minTurns) continue;
      const paired = hasBehavioralSignal(s.activity);
      const phrases = [...s.phrases].slice(0, 3).map((p) => `"${p}"`).join(', ');
      findings.push({
        heuristicId: 'verbal-hedge',
        severity: paired ? 'warn' : 'info',
        summary:
          `${s.hedged.length} replies in session ${sessionId.slice(0, 8)} hedged or self-corrected in the last ${windowMinutes} minutes (${phrases})` +
          (paired ? ', alongside repeated or failing tool activity' : ''),
        eventRefs: s.hedged.map((e) => e.eventId),
        suggestedAction: paired
          ? 'The agent sounds unsure and is repeating or failing actions; consider stepping in with more context'
          : 'The agent sounds unsure; skim its recent replies',
        detectedAt: ctx.now,
      });
    }
    return findings;
  },
};
