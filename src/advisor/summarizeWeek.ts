import { Review } from '../review/review';
import { DigestPolicy } from './digest';
import { PromptLayers, systemPrompt } from './prompts';
import { ChatMessage } from './providers';

/**
 * Summarize the week: the advisor reads the review's usage and findings
 * (counts by model, day, and tool category; the costliest sessions; which
 * heuristics fired) and says what stood out. The data holds no replies,
 * paths, commands, or session names; the costliest sessions' first prompts
 * go only to an advisor whose policy allows prompts. Appended to the review
 * file as model output. The system prompt's layers are in ./prompts.ts.
 */

/** The week's data as sent: usage and which heuristics fired, without responses or snapshots; first prompts only when allowed. */
export function weekData(r: Review, policy?: DigestPolicy): unknown {
  return {
    period: { from: r.input.from, to: r.input.to },
    usage: { ...r.usage, costliest: r.usage.costliest.map(({ firstPrompt, ...s }) => (policy?.prompts && firstPrompt ? { ...s, firstPrompt } : s)) },
    heuristics: r.heuristics.map((h) => ({ id: h.id, episodes: h.episodes, warnings: h.warnings, sessions: h.sessions })),
    muted: r.input.muted,
  };
}

export function summarizeWeekMessages(r: Review, prompts: PromptLayers = {}, policy?: DigestPolicy): ChatMessage[] {
  return [
    { role: 'system', content: systemPrompt('summarize-week', prompts) },
    { role: 'user', content: `Summarize this week.\n\nData:\n${JSON.stringify(weekData(r, policy))}` },
  ];
}

/** An advisor's section, appended to the review file and labelled as model output. */
export function advisorSection(title: string, text: string, advisor: string, warning?: string): string {
  return [
    '',
    `## ${title}`,
    '',
    `> **Model output** from ${advisor}, ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC, from the data above. Its suggestions are for you to judge; nothing is filed or changed.`,
    ...(warning ? ['>', `> **Warning:** ${warning}`] : []),
    '',
    // Its headings sit under this section, whatever level it used.
    text.replace(/^#{1,3} /gm, '### '),
    '',
  ].join('\n');
}
