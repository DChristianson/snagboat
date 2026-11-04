/**
 * The visualizer catalog and the taxonomy its tags come from (see
 * docs/design/visualization-explorer.md). Renderers live in media/viz/ and
 * register by id; the page matches them to these entries, so a visualizer
 * with no entry, or an entry with a tag outside the vocabulary, is caught in
 * unit tests rather than on screen. Nothing here touches vscode or disk: the
 * web demo bundles it for the browser.
 */

export interface TaxonomyFacet {
  label: string;
  /** Each value's one-line question or meaning, shown as a tooltip in the puck. */
  values: Record<string, string>;
}

export type Taxonomy = Record<string, TaxonomyFacet>;

/**
 * Four facets. Values within a facet are not mutually exclusive: a visualizer
 * gives one or more per facet, and every facet must be given, so filters never
 * silently miss a visualizer. `dimension` is the open-ended one.
 */
export const TAXONOMY = {
  category: {
    label: 'Category',
    values: {
      temporal: 'When did something happen, and for how long?',
      actor: 'Who interacted with whom?',
      conversational: 'What was communicated, and in what sequence?',
      dependency: 'What depended on what?',
      quantitative: 'How much, how often, how expensive?',
      state: 'What state was the system in, and how did it change?',
      semantic: 'What was the content about, and how did ideas relate?',
    },
  },
  purpose: {
    label: 'Purpose',
    values: {
      informative: 'Communicates precise information, supports inspection, or enables diagnosis',
      expressive: 'Communicates patterns, scale, complexity, activity, or structure through an engaging visual',
    },
  },
  level: {
    label: 'Level',
    values: {
      session: 'One continuous conversation or workflow',
      project: 'Multiple sessions within a project (a workspace)',
    },
  },
  dimension: {
    label: 'Dimension',
    values: {
      time: 'Time',
      actor: 'Actor (human, agent, tool)',
      hierarchy: 'Hierarchy',
      dependency: 'Dependency',
      communication: 'Communication',
      quantity: 'Quantity (cost)',
      content: 'Content (what was said)',
    },
  },
} satisfies Taxonomy;

export type Facet = keyof typeof TAXONOMY;

export type VisualizerTags = Record<Facet, string[]>;

export interface VisualizerEntry {
  id: string;
  title: string;
  description: string;
  tags: VisualizerTags;
}

/** The most sessions the explorer loads at once; every SessionView carries all of a session's calls and prompts. */
export const EXPLORE_SESSION_CAP = 8;

/** One entry per visualizer, in carousel order. */
export const CATALOG: VisualizerEntry[] = [
  {
    id: 'turn-tree',
    title: 'Turn tree',
    description: 'Where the tokens went: by session, then prompt, then agent, then tool category.',
    tags: { category: ['quantitative', 'actor'], purpose: ['informative'], level: ['session', 'project'], dimension: ['quantity', 'actor', 'hierarchy'] },
  },
  {
    id: 'context-timeline',
    title: 'Context timeline',
    description: 'Context sent by each model call over clock time, with prompts, compactions, findings, and limits.',
    tags: { category: ['temporal', 'quantitative', 'state'], purpose: ['informative'], level: ['session'], dimension: ['time', 'quantity'] },
  },
  {
    id: 'session-strips',
    title: 'Session strips',
    description: 'One row per session over clock time: turns as blocks, compactions as ticks, findings as badges. Idle gaps stay visible.',
    tags: { category: ['temporal', 'state'], purpose: ['expressive', 'informative'], level: ['project'], dimension: ['time'] },
  },
  {
    id: 'cost-per-prompt',
    title: 'Cost per prompt',
    description: 'One column per turn, tokens stacked by agent or by tool category, sessions side by side on one y axis.',
    tags: { category: ['quantitative', 'conversational'], purpose: ['informative'], level: ['session', 'project'], dimension: ['quantity', 'actor'] },
  },
  {
    id: 'context-fill',
    title: 'Context fill',
    description: 'Context size per call by call index, one line per session, so sessions line up by progress rather than clock.',
    tags: { category: ['state', 'quantitative'], purpose: ['expressive', 'informative'], level: ['project'], dimension: ['time', 'quantity'] },
  },
  {
    id: 'sequence-diagram',
    title: 'Sequence diagram',
    description: 'Who sent what to whom, in order: you, the main agent, subagents, and tool categories as lifelines, read top to bottom.',
    tags: { category: ['conversational', 'actor'], purpose: ['informative'], level: ['session'], dimension: ['communication', 'actor', 'time'] },
  },
  {
    id: 'event-graph',
    title: 'Event graph',
    description: 'What led to what: prompts, model calls, tool calls, subagents, and compactions as nodes, with inferred links drawn dashed.',
    tags: { category: ['dependency', 'conversational'], purpose: ['expressive', 'informative'], level: ['session'], dimension: ['dependency', 'communication'] },
  },
  {
    id: 'actor-graph',
    title: 'Actor graph',
    description: 'Who worked with whom: you, agents, subagents, models, and tool categories, joined by typed edges sized by how often they interacted.',
    tags: { category: ['actor'], purpose: ['expressive', 'informative'], level: ['session', 'project'], dimension: ['actor', 'communication', 'quantity'] },
  },
  {
    id: 'prompt-terms',
    title: 'Prompt terms',
    description: 'What your prompts were about: words you used, joined when they appear in the same prompt. Word counts, not a model’s reading.',
    tags: { category: ['semantic'], purpose: ['expressive'], level: ['session', 'project'], dimension: ['content'] },
  },
  {
    id: 'gantt',
    title: 'Gantt and waterfall',
    description: 'Where the time went: rows for you, each agent, and each tool category over clock time, or one row per turn that opens into its own time axis.',
    tags: { category: ['temporal'], purpose: ['informative'], level: ['session'], dimension: ['time', 'actor', 'hierarchy'] },
  },
  {
    id: 'treemap',
    title: 'Treemap',
    description: 'Tokens as area: by session, turn, and tool category, or by tool category across sessions.',
    tags: { category: ['quantitative'], purpose: ['expressive', 'informative'], level: ['session', 'project'], dimension: ['quantity', 'hierarchy'] },
  },
  {
    id: 'heatmap',
    title: 'Heatmap',
    description: 'Patterns across sessions: tokens by session and hour, tool calls by session and category, or findings by heuristic and day.',
    tags: { category: ['quantitative', 'temporal'], purpose: ['expressive', 'informative'], level: ['project'], dimension: ['quantity', 'time'] },
  },
  {
    id: 'tool-ribbon',
    title: 'Tool-call ribbon',
    description: 'Which tool category followed which within turns: sources on the left, what came next on the right, ribbons as wide as the step was common.',
    tags: { category: ['dependency', 'conversational'], purpose: ['expressive', 'informative'], level: ['session'], dimension: ['dependency', 'communication'] },
  },
  {
    id: 'week-picture',
    title: 'Week in one picture',
    description: 'Seven days as rings around a 24-hour clock: tokens by hour as color, findings as dots, over the loaded sessions.',
    tags: { category: ['temporal', 'quantitative'], purpose: ['expressive'], level: ['project'], dimension: ['time', 'quantity'] },
  },
  {
    id: 'histogram',
    title: 'Histogram',
    description: 'How a measurement is spread: tokens per call, time between calls, or per-turn counts, stacked by session.',
    tags: { category: ['quantitative'], purpose: ['informative'], level: ['session', 'project'], dimension: ['quantity'] },
  },
  {
    id: 'box-violin',
    title: 'Box and violin',
    description: 'How a measurement varies from session to session: density, quartiles, and outliers, one row each.',
    tags: { category: ['quantitative'], purpose: ['informative'], level: ['project'], dimension: ['quantity'] },
  },
  {
    id: 'ridgeline',
    title: 'Ridgeline',
    description: 'The shape of a per-call measurement by session or by model, as overlapping density curves on one axis.',
    tags: { category: ['quantitative'], purpose: ['expressive', 'informative'], level: ['project'], dimension: ['quantity'] },
  },
  {
    id: 'scatter',
    title: 'Scatter plot',
    description: 'Every turn as a point: how long it ran against its tokens, model calls, or tool calls, on log axes.',
    tags: { category: ['quantitative'], purpose: ['informative'], level: ['session', 'project'], dimension: ['quantity', 'time'] },
  },
  {
    id: 'bubble',
    title: 'Bubble chart',
    description: 'Each session by span and tokens, with area for tool calls and color for its worst finding.',
    tags: { category: ['quantitative'], purpose: ['expressive', 'informative'], level: ['project'], dimension: ['quantity', 'time'] },
  },
];

/**
 * Human-readable problems with a catalog against a taxonomy: a duplicate id,
 * an empty title or description, a facet missing or empty on an entry, or a
 * value outside the facet's vocabulary. An empty list means it conforms.
 */
export function validateCatalog(catalog: VisualizerEntry[], taxonomy: Taxonomy): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const entry of catalog) {
    const name = entry.id || '(no id)';
    if (!entry.id) problems.push('an entry has no id');
    else if (seen.has(entry.id)) problems.push(`duplicate id "${entry.id}"`);
    seen.add(entry.id);
    if (!entry.title) problems.push(`${name}: empty title`);
    if (!entry.description) problems.push(`${name}: empty description`);
    const tags: Record<string, unknown> = entry.tags ?? {};
    for (const [facet, def] of Object.entries(taxonomy)) {
      const values = tags[facet];
      if (!Array.isArray(values) || values.length === 0) {
        problems.push(`${name}: facet "${facet}" is missing or empty`);
        continue;
      }
      for (const v of values) if (typeof v !== 'string' || !(v in def.values)) problems.push(`${name}: "${String(v)}" is not a ${facet} value`);
    }
    for (const facet of Object.keys(tags)) if (!(facet in taxonomy)) problems.push(`${name}: "${facet}" is not a facet`);
  }
  return problems;
}
