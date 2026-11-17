/**
 * The goal tracking lifecycle's records (docs/design/goal-tracking-lifecycle.md): an advisor's period
 * report, the log of its proposals, and the experiments that accepted proposals become. Each has a JSON
 * Schema beside it (report.v1.schema.json, proposalEvent.v1.schema.json, experiment.v1.schema.json),
 * kept in step by a compile-time check in jsonSchema.ts and a unit test, as events are. Nothing
 * validates against the schemas at run time.
 */

/** How often an advisor reports. */
export type AdvisorPeriod = 'daily' | 'weekly' | 'monthly';

/** One measure for a stretch of time, with the value it's compared with. */
export interface MeasureResult {
  id: string;
  label: string;
  unit: string;
  better: 'lower' | 'higher';
  /** This period; undefined when there was nothing to measure. */
  value?: number;
  /** The value it's compared with: the period before, or the last report's. */
  previous?: number;
  /** better, worse or same, when both are there. */
  trend?: 'better' | 'worse' | 'same';
  /** Why there's no value: not recorded yet, or an unknown measure id. */
  note?: string;
  /** One value per day or week, oldest first (null: nothing to measure then), when asked for. */
  series?: Array<number | null>;
}

/** The rules in force when a report was written: team settings (thresholds, rules, nudges) and saved rules. */
export interface RulesInForce {
  /** config.json defaults, team keys only. */
  defaults: Record<string, unknown>;
  /** config.json projects, team keys only, by folder. */
  projects: Record<string, Record<string, unknown>>;
  /** rules.json's saved rules, as written. */
  saved: unknown[];
}

/** Where a change applies: every workspace, or one. */
export type ChangeScope = 'global' | { workspace: string };

/**
 * One change to the tracking rules: a setting (a threshold on an existing rule, such as
 * heuristics.cacheThrash.minTokens), or a saved rule, new or changed.
 */
export type RuleChange =
  | {
      kind: 'setting';
      /** The setting's key without the snagboat. prefix. */
      key: string;
      /** Its value before; absent when it was unset. */
      before?: string | number | boolean;
      after: string | number | boolean;
    }
  | {
      kind: 'rule';
      /** The saved rule as it will be written (rules.json's format). */
      rule: Record<string, unknown> & { id: string };
      /** The saved rule it replaces; absent for a new rule. */
      before?: Record<string, unknown>;
    };

/** What a change should do to a measure, tracked once it's accepted. */
export interface Prediction {
  /** A measure id (the advisor's measures). */
  measure: string;
  /** In plain words: "Cache hit rate back above 66% at the next report." */
  text: string;
  /** A number to check it against, when there is one. */
  target?: { direction: 'below' | 'above'; value: number };
}

/** A running experiment's result in a report. */
export interface Verdict {
  experiment: string;
  measure: string;
  baseline?: number;
  now?: number;
  /** Against its prediction: met, not met, too early to say, or mixed up with another experiment on the same measure and scope. */
  result: 'met' | 'not-met' | 'too-early' | 'confounded';
  text: string;
}

/** What the advisor's model returned for a report, once per revision. */
export interface ReportRevision {
  /** 1 for the first answer; each Revise report adds one. */
  rev: number;
  createdAt: string;
  /** The model advisor (snagboat.advisors) that wrote it, and its model. */
  model?: { advisor: string; model?: string };
  summary: string;
  verdicts: Verdict[];
  /** The proposals in this revision, by id (proposals.jsonl). */
  proposals: string[];
  /** Sent back: accept report (none marked revise), or revise report. */
  sent?: { at: string; as: 'accept' | 'revise' };
}

/** An advisor's report for one stretch of time (~/.snagboat/advisors/<id>/periods/<id>.json). */
export interface PeriodReport {
  version: 1;
  /** 2026-W46 for a scheduled report; 2026-W47-asked-1 for the first you asked for in that period. */
  id: string;
  advisor: string;
  /** The advisor's version (a hash of its persona.md) when the report was written. */
  advisorVersion: string;
  period: AdvisorPeriod;
  /** The period it falls in: 2026-W46. */
  label: string;
  /** Start, inclusive (ISO): the last report's end, or the period's start for an advisor's first. */
  from: string;
  /** End, exclusive (ISO). */
  to: string;
  trigger: 'schedule' | 'request';
  createdAt: string;
  /** The report before it, whose measures are this one's "before". */
  previous?: string;
  /** All workspaces together; `previous` is the last report's value. Frozen when written. */
  measures: MeasureResult[];
  /** Each workspace with events in the report's time, the same measures. */
  workspaces: Array<{ workspace: string; measures: MeasureResult[] }>;
  rules: RulesInForce;
  /** Where the goal stands, in one line, from the numbers alone. */
  summary: string;
  /** The model's answers, oldest first; absent with no model. */
  revisions?: ReportRevision[];
}

/**
 * One line of an advisor's proposal log (~/.snagboat/advisors/<id>/proposals.jsonl), append only. A
 * `proposed` line carries the change; the rest record what you did with it.
 */
export interface ProposalEvent {
  version: 1;
  at: string;
  /** The proposal's id. */
  proposal: string;
  advisor: string;
  type: 'proposed' | 'accepted' | 'discarded' | 'revised' | 'kept' | 'closed';
  /** The report (and revision) it belongs to. */
  report?: string;
  rev?: number;
  /** proposed: one line naming it, "Catch smaller cache rewrites". */
  title?: string;
  change?: RuleChange;
  scope?: ChangeScope;
  /** proposed: what the change does, in plain words. */
  what?: string;
  /** proposed: the reason, with the numbers behind it. */
  why?: string;
  prediction?: Prediction;
  /** proposed: the proposal this one answers a revise note on. */
  replaces?: string;
  /** revised: your note. */
  note?: string;
}

/** A proposal, folded from its log lines. */
export interface Proposal {
  id: string;
  advisor: string;
  report: string;
  rev: number;
  title: string;
  change: RuleChange;
  scope: ChangeScope;
  what: string;
  why: string;
  prediction: Prediction;
  replaces?: string;
  /** Its latest mark: open until you mark it; closed once its report is sent or it's replaced. */
  status: 'open' | 'accepted' | 'discarded' | 'revised' | 'kept' | 'closed';
  note?: string;
  proposedAt: string;
  updatedAt: string;
}

/** An accepted proposal, applied and tracked (~/.snagboat/experiments/<id>.json). */
export interface Experiment {
  version: 1;
  id: string;
  advisor: string;
  /** The proposal it came from. */
  proposal: string;
  title: string;
  change: RuleChange;
  scope: ChangeScope;
  /** The tracked measure's value when it started, from the report it was accepted in. */
  baseline: { report: string; measure: string; value?: number };
  prediction: Prediction;
  startedAt: string;
  /** When the next report should judge it; moves one period each time you keep it going. */
  reviewAt: string;
  status: 'running' | 'ended';
  /** How it ended: you accepted the result, reverted it, or a later experiment replaced it. */
  ended?: { at: string; how: 'accepted' | 'reverted' | 'replaced'; by?: string };
  /** How many times you kept it going at a review. */
  keptGoing: number;
  /** Running experiments on the same measure and scope when it started. */
  overlaps?: string[];
}
