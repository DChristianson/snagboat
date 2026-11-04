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
