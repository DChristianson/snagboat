import { categoryLabel, EventToolCategory } from '../core/toolCategory';

/**
 * A feature discovery measures on every past turn, written as a turn-scoped
 * rule measure so an outlier is already a rule: its candidate is the same
 * rule with a threshold at your own tail. See docs/design/trusted-advisor.md.
 */
export interface Probe {
  /** Part of the candidate's id: `discovery:<key>`. */
  key: string;
  /** Completes "turns with 7 or more …". */
  describes: string;
  title: string;
  /** Rule measures; the one probed is named `value`. */
  measures: Record<string, unknown>;
  /** A condition a turn must meet to be counted at all (a failure rate needs a few calls to mean anything). */
  gate?: { measure: string; gte: number };
  summary: string;
  suggestedAction: string;
  /** How thresholds step: whole counts, shares in 5% steps, or tokens rounded to two significant digits. */
  kind: 'count' | 'share' | 'tokens';
  /** The lowest threshold worth a heuristic, however quiet your turns are. */
  floor: number;
  /** A built-in already covers this; discovery suggests a threshold for it instead of a new rule. */
  builtIn?: { heuristic: string; setting: string; fallback: number };
}

const TOOL = { kind: 'tool_call' };

/** Per-category probes for categories that have targets worth repeating on. */
const TARGETED: ReadonlySet<string> = new Set(['file-read', 'search', 'shell', 'script', 'tests-builds', 'version-control', 'web', 'mcp']);

function slug(category: EventToolCategory): string {
  return category.replace(/[^a-z0-9]+/g, '-');
}

/** The fixed probes, plus per-category ones for the categories in your history. */
export function probesFor(categories: Iterable<EventToolCategory>): Probe[] {
  const probes: Probe[] = [
    {
      key: 'model-calls',
      describes: 'model calls',
      title: 'Many model calls in one turn',
      measures: { value: { type: 'count', filter: { kind: 'turn_stop', hasTokens: true } } },
      summary: '{value} model calls in this turn',
      suggestedAction: 'Check the turn is still on track; a narrower prompt may need fewer steps.',
      kind: 'count',
      floor: 10,
      builtIn: { heuristic: 'runaway-turn', setting: 'maxModelCalls', fallback: 100 },
    },
    {
      key: 'tool-calls',
      describes: 'tool calls',
      title: 'Many tool calls in one turn',
      measures: { value: { type: 'count', filter: TOOL } },
      summary: '{value} tool calls in this turn',
      suggestedAction: 'Check the turn is still on track; a narrower prompt may need fewer steps.',
      kind: 'count',
      floor: 10,
      builtIn: { heuristic: 'runaway-turn', setting: 'maxToolCalls', fallback: 100 },
    },
    {
      key: 'turn-tokens',
      describes: 'tokens',
      title: 'Expensive turn',
      measures: { value: { type: 'sumTokens' } },
      summary: '{value} tokens in this turn',
      suggestedAction: 'A turn this large may be rereading a long context; consider a fresh session or a narrower prompt.',
      kind: 'tokens',
      floor: 100_000,
    },
    {
      key: 'failures-one-target',
      describes: 'failures on one target',
      title: 'Repeated failures on one target',
      measures: { value: { type: 'maxPerTarget', filter: { ...TOOL, status: 'failure', hasTarget: true } } },
      summary: '{target} failed {value} times in this turn',
      suggestedAction: 'Look at why it keeps failing before the agent tries again.',
      kind: 'count',
      floor: 2,
      builtIn: { heuristic: 'backtracking', setting: 'minFailures', fallback: 3 },
    },
    {
      key: 'edits-one-file',
      describes: 'edits of one file',
      title: 'Repeated edits of one file',
      measures: { value: { type: 'maxPerTarget', filter: { ...TOOL, toolCategory: 'file-edit', hasTarget: true } } },
      summary: '{target} edited {value} times in this turn',
      suggestedAction: 'Review recent changes to {target}.',
      kind: 'count',
      floor: 3,
      builtIn: { heuristic: 'backtracking', setting: 'minEdits', fallback: 10 },
    },
    {
      key: 'failure-run',
      describes: 'failed tool calls in a row',
      title: 'Failures in a row',
      measures: { value: { type: 'consecutive', filter: { ...TOOL, status: 'failure' } } },
      summary: '{value} tool calls failed in a row',
      suggestedAction: 'The agent may be retrying the same thing; check what it is running into.',
      kind: 'count',
      floor: 3,
    },
    {
      key: 'failure-rate',
      describes: 'of tool calls failing',
      title: 'Most tool calls failing',
      measures: { calls: { type: 'count', filter: { ...TOOL, status: ['success', 'failure'] } }, value: { type: 'failureRate', filter: TOOL } },
      gate: { measure: 'calls', gte: 5 },
      summary: '{value} of {calls} tool calls failed in this turn',
      suggestedAction: 'Something in the environment may be broken; check before the agent works around it.',
      kind: 'share',
      floor: 0.3,
    },
  ];
  for (const category of [...new Set(categories)].sort()) {
    const label = categoryLabel(category);
    const filter = { ...TOOL, toolCategory: category };
    probes.push({
      key: `${slug(category)}-calls`,
      describes: `${label.toLowerCase()} calls`,
      title: `Many ${label.toLowerCase()} calls`,
      measures: { value: { type: 'count', filter } },
      summary: `{value} ${label.toLowerCase()} calls in this turn`,
      suggestedAction: 'Check what the agent keeps doing; it may be missing context or going in circles.',
      kind: 'count',
      floor: 5,
    });
    if (category === 'file-read') {
      probes.push({
        key: 'reads-one-file',
        describes: 'reads of one file',
        title: 'Re-reading the same file',
        measures: { value: { type: 'maxPerTarget', filter: { ...filter, hasTarget: true } } },
        summary: '{target} read {value} times in this turn',
        suggestedAction: "The agent may be losing track of the file's contents; consider pointing it at the relevant lines.",
        kind: 'count',
        floor: 3,
      });
    } else if (TARGETED.has(category) || category.includes(':shell/')) {
      probes.push({
        key: `${slug(category)}-one-target`,
        describes: `${label.toLowerCase()} calls on one target`,
        title: `Repeated ${label.toLowerCase()} calls on one target`,
        measures: { value: { type: 'maxPerTarget', filter: { ...filter, hasTarget: true } } },
        summary: `{target}: {value} ${label.toLowerCase()} calls in this turn`,
        suggestedAction: 'The agent may be repeating itself; check whether it has what it needs.',
        kind: 'count',
        floor: 3,
      });
    }
  }
  return probes;
}

/** The candidate rule for a probe at a threshold. */
export function probeRule(probe: Probe, threshold: number): Record<string, unknown> & { id: string } {
  const value = { measure: 'value', gte: threshold };
  return {
    id: `discovery:${probe.key}`,
    title: probe.title,
    scope: 'turn',
    measures: probe.measures,
    when: probe.gate ? { all: [probe.gate, value] } : value,
    severity: 'info',
    summary: probe.summary,
    suggestedAction: probe.suggestedAction,
  };
}
