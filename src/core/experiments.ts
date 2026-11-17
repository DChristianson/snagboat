import * as fs from 'fs';
import * as path from 'path';
import { ChangeScope, Experiment, PeriodReport, Proposal, RuleChange } from '@snagboat/schema';
import { nextPeriod, periodStart } from '../advisor/report';
import { RuleStore } from '../heuristics/ruleStore';
import { loadConfig, saveConfig, SnagboatConfig } from './config';
import { workspaceInfoOf } from './userStore';

/**
 * Experiments (docs/design/goal-tracking-lifecycle.md, snagboat-79f.7.8): an accepted proposal, applied and
 * tracked. One file each, ~/.snagboat/experiments/<id>.json, kept forever: the change, its scope, a baseline
 * copied from the report it was accepted in, the prediction, when the next report judges it, and a status.
 *
 * Applying knows its scope. A setting goes to config.json: `defaults` for a global change, `projects[folder]`
 * for one workspace's, where the running heuristics read it on their next evaluation (VS Code windows take
 * changes to config.json, as they do the Suggestions page's). A global rule is saved to rules.json with its
 * provenance naming the experiment; a workspace's rule goes in that project's `rules` setting. Reverting puts
 * back exactly what was in that place before.
 */

const ID = /^[a-z][a-z0-9-]*$/i;

export class ExperimentStore {
  constructor(
    private readonly home: string,
    private readonly now: () => Date = () => new Date(),
    /** After a change is applied or reverted: re-run the heuristics. */
    private readonly changed: () => void = () => undefined
  ) {}

  private dir(): string {
    return path.join(this.home, 'experiments');
  }

  list(): Experiment[] {
    let files: string[] = [];
    try {
      files = fs.readdirSync(this.dir()).filter((f) => f.endsWith('.json'));
    } catch {
      return [];
    }
    const out: Experiment[] = [];
    for (const f of files) {
      try {
        const x = JSON.parse(fs.readFileSync(path.join(this.dir(), f), 'utf8')) as Experiment;
        if (x && x.version === 1) out.push(x);
      } catch {
        // unreadable: skipped
      }
    }
    return out.sort((a, b) => b.startedAt.localeCompare(a.startedAt) || a.id.localeCompare(b.id));
  }

  get(id: string): Experiment | undefined {
    return this.list().find((x) => x.id === id);
  }

  private write(x: Experiment): void {
    if (!ID.test(x.id)) throw new Error(`bad experiment id ${x.id}`);
    fs.mkdirSync(this.dir(), { recursive: true, mode: 0o700 });
    const file = path.join(this.dir(), `${x.id}.json`);
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(x, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(tmp, file);
  }

  /** Accept report: each accepted proposal is applied and becomes a running experiment. */
  async start(report: PeriodReport, accepted: Proposal[]): Promise<Experiment[]> {
    const started: Experiment[] = [];
    for (const p of accepted) {
      if (this.get(p.id)) continue; // already an experiment (a carried-over proposal)
      const at = this.now().toISOString();
      const running = this.list().filter((x) => x.status === 'running');
      // A newer change to the same thing in the same scope replaces the running one.
      for (const old of running.filter((x) => sameTarget(x, p))) {
        this.write({ ...old, status: 'ended', ended: { at, how: 'replaced', by: p.id } });
      }
      const applied = await this.apply(p.change, p.scope, p.id);
      const measures = p.scope === 'global' ? report.measures : report.workspaces.find((w) => w.workspace === (p.scope as { workspace: string }).workspace)?.measures ?? [];
      const value = measures.find((m) => m.id === p.prediction.measure)?.value;
      const overlaps = running.filter((x) => !sameTarget(x, p) && x.prediction.measure === p.prediction.measure && sameScope(x.scope, p.scope)).map((x) => x.id);
      const x: Experiment = {
        version: 1,
        id: p.id,
        advisor: p.advisor,
        proposal: p.id,
        title: p.title,
        change: applied,
        scope: p.scope,
        baseline: { report: report.id, measure: p.prediction.measure, ...(value !== undefined ? { value } : {}) },
        prediction: p.prediction,
        startedAt: at,
        reviewAt: nextPeriod(report.period, periodStart(report.period, new Date(report.to))).toISOString(),
        status: 'running',
        keptGoing: 0,
        ...(overlaps.length ? { overlaps } : {}),
      };
      this.write(x);
      for (const id of overlaps) {
        const other = this.get(id)!;
        this.write({ ...other, overlaps: [...new Set([...(other.overlaps ?? []), x.id])] });
      }
      started.push(x);
    }
    if (started.length) this.changed();
    return started;
  }

  /** Reverts a running experiment: what was there before goes back, and it ends. */
  async revert(id: string): Promise<Experiment> {
    const x = this.get(id);
    if (!x) throw new Error(`no experiment ${id}`);
    if (x.status !== 'running') throw new Error(`${x.title} has already ended`);
    await this.undo(x.change, x.scope);
    const ended: Experiment = { ...x, status: 'ended', ended: { at: this.now().toISOString(), how: 'reverted' } };
    this.write(ended);
    this.changed();
    return ended;
  }

  /** Writes the change in its scope; returns it with `before` as that place held it (absent: unset there). */
  private async apply(change: RuleChange, scope: ChangeScope, experiment: string): Promise<RuleChange> {
    if (change.kind === 'setting') {
      const { config } = loadConfig(this.home);
      const layer = settingsLayer(config, scope);
      const before = layer[change.key];
      saveConfig(this.home, withLayer(config, scope, { ...layer, [change.key]: change.after }));
      const { before: _b, ...rest } = change;
      return isScalar(before) ? { ...rest, before } : rest;
    }
    if (scope === 'global') {
      const store = new RuleStore(this.home);
      await store.load().catch(() => undefined);
      const before = store.list('rules').find((r) => r.doc.id === change.rule.id)?.doc;
      await store.save('rules', change.rule, { proposedBy: 'advisor', addedAt: this.now().toISOString(), experiment });
      const { before: _b, ...rest } = change;
      return before ? { ...rest, before } : rest;
    }
    const { config } = loadConfig(this.home);
    const layer = settingsLayer(config, scope);
    const rules = Array.isArray(layer.rules) ? (layer.rules as Array<Record<string, unknown>>) : [];
    const before = rules.find((r) => r.id === change.rule.id);
    saveConfig(this.home, withLayer(config, scope, { ...layer, rules: [...rules.filter((r) => r.id !== change.rule.id), change.rule] }));
    const { before: _b, ...rest } = change;
    return before ? { ...rest, before } : rest;
  }

  private async undo(change: RuleChange, scope: ChangeScope): Promise<void> {
    if (change.kind === 'setting') {
      const { config } = loadConfig(this.home);
      const layer = { ...settingsLayer(config, scope) };
      if (change.before === undefined) delete layer[change.key];
      else layer[change.key] = change.before;
      saveConfig(this.home, withLayer(config, scope, layer));
      return;
    }
    if (scope === 'global') {
      const store = new RuleStore(this.home);
      await store.load().catch(() => undefined);
      if (change.before) await store.save('rules', change.before as Record<string, unknown> & { id: string }, { proposedBy: 'you', addedAt: this.now().toISOString() });
      else await store.remove('rules', change.rule.id);
      return;
    }
    const { config } = loadConfig(this.home);
    const layer = settingsLayer(config, scope);
    const rules = (Array.isArray(layer.rules) ? (layer.rules as Array<Record<string, unknown>>) : []).filter((r) => r.id !== change.rule.id);
    saveConfig(this.home, withLayer(config, scope, { ...layer, rules: change.before ? [...rules, change.before] : rules }));
  }
}

const isScalar = (v: unknown): v is string | number | boolean => typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean';

/** The config.json folder key for a scope: a workspace's folder. */
export function scopeFolder(scope: ChangeScope): string | undefined {
  return scope === 'global' ? undefined : workspaceInfoOf(scope.workspace).folder ?? scope.workspace;
}

function settingsLayer(config: SnagboatConfig, scope: ChangeScope): Record<string, unknown> {
  const folder = scopeFolder(scope);
  return folder === undefined ? config.defaults : config.projects[folder] ?? {};
}

function withLayer(config: SnagboatConfig, scope: ChangeScope, layer: Record<string, unknown>): SnagboatConfig {
  const folder = scopeFolder(scope);
  return folder === undefined ? { ...config, defaults: layer } : { ...config, projects: { ...config.projects, [folder]: layer } };
}

function sameScope(a: ChangeScope, b: ChangeScope): boolean {
  return (a === 'global' ? '' : a.workspace) === (b === 'global' ? '' : b.workspace);
}

/** The same setting or rule, in the same scope. */
function sameTarget(x: Experiment, p: Proposal): boolean {
  if (!sameScope(x.scope, p.scope) || x.change.kind !== p.change.kind) return false;
  return x.change.kind === 'setting' ? x.change.key === (p.change as { key: string }).key : x.change.rule.id === (p.change as { rule: { id: string } }).rule.id;
}
