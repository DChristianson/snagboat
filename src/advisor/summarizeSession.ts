import { digestText, SessionDigest } from './digest';
import { oneLine, PromptLayers, systemPrompt } from './prompts';
import { ChatMessage } from './providers';

/**
 * Summarize a session: what happened in a session, one turn of it, or one
 * finding, as Markdown shown beside the session. The Sessions tab calls it
 * Explain. The short form is the headline: one line per ended session, for
 * the session list. The system prompt's layers are in ./prompts.ts.
 */

/** What the summary is about. */
export type SessionFocus = { kind: 'session' } | { kind: 'turn'; turn: number } | { kind: 'finding'; heuristicId: string; summary: string };

function question(focus: SessionFocus): string {
  switch (focus.kind) {
    case 'session':
      return 'Explain this session: what the agent spent its effort on, what went wrong if anything, and what the person could do differently.';
    case 'turn':
      return `Explain turn ${focus.turn}: what the agent did after that prompt, whether it went well, and why.`;
    case 'finding':
      return `Snagboat's "${focus.heuristicId}" heuristic reported: ${JSON.stringify(focus.summary)}. Explain what this finding means in this session, whether it looks like a real problem, and what to try.`;
  }
}

/** The messages for a summary: the system prompt (persona, instruction, fixed tail), then the question and the digest. */
export function summarizeSessionMessages(digest: SessionDigest, focus: SessionFocus, prompts: PromptLayers = {}): ChatMessage[] {
  return [
    { role: 'system', content: systemPrompt('summarize-session', prompts) },
    { role: 'user', content: `${question(focus)}\n\nDigest:\n${digestText(digest)}` },
  ];
}

/** The short form: a one-line headline for a session that has ended. */
export function headlineMessages(digest: SessionDigest, prompts: PromptLayers = {}): ChatMessage[] {
  return [
    { role: 'system', content: systemPrompt('summarize-session/headline', prompts) },
    { role: 'user', content: `Give this session a headline.\n\nDigest:\n${digestText(digest)}` },
  ];
}

/** The headline as one line for the session list, or undefined when the model had nothing specific. */
export function headlineLine(text: string): string | undefined {
  return oneLine(text, 120);
}
