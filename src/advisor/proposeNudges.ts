import { Review } from '../review/review';
import { DigestPolicy, digestText, SessionDigest } from './digest';
import { oneLine, PromptLayers, systemPrompt } from './prompts';
import { ChatMessage } from './providers';

/**
 * Propose nudges, in two forms. The review form reads how findings were
 * shown (status bar snapshots with the fixed checks, and how the person
 * responded) and proposes better ways to show them. The live form writes one
 * short suggestion for the turn a finding just fired in, shown under the
 * finding in the status bar tooltip as model output. The system prompts'
 * layers are in ./prompts.ts.
 */

/** The review's presentation data: findings as ids, never summaries, so it's the same for every advisor. */
export function nudgeReviewData(r: Review): unknown {
  return {
    period: { from: r.input.from, to: r.input.to },
    heuristics: r.heuristics,
    respondingSince: r.input.respondingSince ?? null,
    muted: r.input.muted,
    presentation: {
      momentsLookedAt: r.presentation.moments,
      snapshots: r.presentation.snapshots.map((s) => ({ at: s.moment.at, active: s.moment.active, statusBar: s.statusBar, tooltip: s.tooltip })),
      fixedChecks: r.presentation.checks.map((c) => ({ id: c.id, title: c.title, moments: c.moments, recommendation: c.recommendation })),
    },
  };
}

export function proposeNudgesMessages(r: Review, prompts: PromptLayers = {}, _policy?: DigestPolicy): ChatMessage[] {
  return [
    { role: 'system', content: systemPrompt('propose-nudges/review', prompts) },
    { role: 'user', content: `Review how findings were shown this week.\n\nData:\n${JSON.stringify(nudgeReviewData(r))}` },
  ];
}

/** The live form: one line about the turn a finding fired in. */
export function nudgeLineMessages(digest: SessionDigest, heuristicId: string, summary: string, early: boolean, prompts: PromptLayers = {}): ChatMessage[] {
  const what = early ? `It's heading toward Snagboat's "${heuristicId}" heuristic: ${JSON.stringify(summary)}.` : `Snagboat's "${heuristicId}" heuristic reported: ${JSON.stringify(summary)}.`;
  return [
    { role: 'system', content: systemPrompt('propose-nudges/live', prompts) },
    { role: 'user', content: `A finding just fired while the person is working. ${what}\n\nDigest:\n${digestText(digest)}` },
  ];
}

/** The answer as one line for the tooltip, or undefined when it had nothing specific to say. */
export function nudgeLine(text: string): string | undefined {
  return oneLine(text, 240);
}
