/**
 * What each built-in heuristic reports, for abilities that see heuristic ids
 * without their summaries (the week's summary and the nudge review), so a
 * model reads their counts for what they are.
 */
export const HEURISTIC_GLOSSARY = [
  '- stalled: an unfinished turn with no agent activity for a while. Often the agent is waiting on the person (a permission prompt, a question, or a turn they walked away from), not stuck; the data can\'t tell which.',
  '- runaway-turn: one prompt drove very many model or tool calls.',
  '- context-pressure: the context neared the model\'s limit, or was compacted automatically.',
  '- cache-thrash: model calls rewrote the prompt cache instead of reusing it.',
  '- backtracking: the same target failing, or one file edited, many times in a turn.',
  '- tool-churn: many tool calls in a few minutes on the same one or two targets.',
  '- verbal-hedge: the agent\'s replies kept hedging or correcting themselves.',
  '- token-budget: a session or day went over the token budget you set.',
  'Ids with a colon (user:, discovery:, advisor:) are rules the person accepted.',
].join('\n');
