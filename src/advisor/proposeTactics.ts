import { SessionDigest } from './digest';
import { PromptLayers, systemPrompt } from './prompts';
import { ChatMessage } from './providers';

/**
 * Propose tactics: whether model use and prompt tactics could be refined,
 * from one session's digest (Tactics, in the Sessions tab) or the week's
 * costliest sessions (a section of the review). Each turn's model, prompt
 * (policy permitting), tokens, and tools are in the digest already; an
 * optional table of your own model tiers goes with it. Markdown, shown as a
 * summary is. The system prompt's layers are in ./prompts.ts.
 */

/** `snagboat.advisor.modelTiers`: fragments of model names to the tier you count them as. */
export type ModelTiers = Record<string, string>;

export function proposeTacticsMessages(digests: SessionDigest[], prompts: PromptLayers = {}, modelTiers?: ModelTiers): ChatMessage[] {
  const tiers = modelTiers && Object.keys(modelTiers).length > 0 ? modelTiers : undefined;
  const question =
    digests.length === 1
      ? 'Propose tactics for this session: where the model used did not fit the ask, and where a different way of prompting would have cost less or gone better.'
      : `Propose tactics from these ${digests.length} sessions, the costliest of the week: where the model used did not fit the ask, and where a different way of prompting would have cost less or gone better.`;
  return [
    { role: 'system', content: systemPrompt('propose-tactics', prompts) },
    { role: 'user', content: `${question}\n\nData:\n${JSON.stringify({ sessions: digests, ...(tiers ? { modelTiers: tiers } : {}) })}` },
  ];
}
