import * as vscode from 'vscode';
import { buildRuleSet, Rule } from '../heuristics/rule';
import { Provenance, RuleStore } from '../heuristics/ruleStore';
import { Score } from '../discovery/discover';
import { parseRulesFile } from './suggestionsController';

/** Snagboat: Export Rules: writes saved rules and categories, with their provenance, to a JSON file you choose. */
export async function exportRules(store: RuleStore): Promise<void> {
  const rules = store.list('rules');
  const categories = store.list('categories');
  if (rules.length === 0 && categories.length === 0) {
    void vscode.window.showInformationMessage('Snagboat: there are no saved rules or tool categories to export.');
    return;
  }
  const uri = await vscode.window.showSaveDialog({ filters: { JSON: ['json'] }, saveLabel: 'Export', title: 'Export Snagboat rules', defaultUri: vscode.Uri.file('snagboat-rules.json') });
  if (!uri) return;
  await vscode.workspace.fs.writeFile(uri, Buffer.from(JSON.stringify({ version: 1, rules, categories }, null, 2)));
  void vscode.window.showInformationMessage(`Snagboat: exported ${rules.length} rule${rules.length === 1 ? '' : 's'} and ${categories.length} tool categor${categories.length === 1 ? 'y' : 'ies'}.`);
}

export interface ImportHooks {
  store: RuleStore;
  /** Replays rules over this workspace's discovery window. */
  score(rules: Rule[]): Promise<Map<string, Score>>;
  workspace: string;
  days: number;
  now(): string;
  rulesChanged(): void;
  output: vscode.OutputChannel;
}

type ImportItem = vscode.QuickPickItem & { section: 'rules' | 'categories'; doc: Record<string, unknown> & { id: string }; replay?: Provenance['replay'] };

/**
 * Snagboat: Import Rules: reads an exported file (or a plain list of rules),
 * replays each rule over this workspace's history, and adds the ones you pick.
 */
export async function importRules(hooks: ImportHooks): Promise<void> {
  const [uri] = (await vscode.window.showOpenDialog({ filters: { JSON: ['json'] }, canSelectMany: false, openLabel: 'Import', title: 'Import Snagboat rules' })) ?? [];
  if (!uri) return;
  const file = parseRulesFile(Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8'));
  if (file.errors.length > 0) {
    void vscode.window.showErrorMessage(`Snagboat: couldn't import ${uri.fsPath}: ${file.errors.join('; ')}`);
    return;
  }
  const set = buildRuleSet([{ ...file, origin: 'imported' }]);
  for (const problem of set.problems) hooks.output.appendLine(`Rules: ${problem}`);
  const scores = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Snagboat: replaying imported rules…' }, () => hooks.score(set.rules));
  const savedRules = new Set(hooks.store.list('rules').map((s) => s.doc.id));
  const savedCategories = new Set(hooks.store.list('categories').map((s) => s.doc.id));
  const docs = new Map((file.rules as Array<Record<string, unknown> & { id: string }>).map((d) => [d.id, d]));
  const categoryDocs = new Map((file.categories as Array<Record<string, unknown> & { id: string }>).map((d) => [d.id, d]));
  const items: ImportItem[] = [
    ...set.rules.map((rule) => {
      const s = scores.get(rule.id);
      return {
        label: rule.id,
        description: `${rule.title}${savedRules.has(rule.id) ? ' (replaces your saved rule)' : ''}`,
        detail: s ? `Would have fired ${s.episodes} time${s.episodes === 1 ? '' : 's'} in ${s.sessions} session${s.sessions === 1 ? '' : 's'} over the last ${hooks.days} days in ${hooks.workspace}` : undefined,
        picked: true,
        section: 'rules' as const,
        doc: docs.get(rule.id)!,
        ...(s ? { replay: { episodes: s.episodes, sessions: s.sessions } } : {}),
      };
    }),
    ...set.categories.map((c) => ({
      label: c.id,
      description: `${c.label}${savedCategories.has(c.id) ? ' (replaces your saved category)' : ''}`,
      detail: `Shell commands starting with ${c.match.join(', ')}`,
      picked: true,
      section: 'categories' as const,
      doc: categoryDocs.get(c.id)!,
    })),
  ];
  if (items.length === 0) {
    void vscode.window.showWarningMessage(`Snagboat: nothing in ${uri.fsPath} could be imported${set.problems.length ? '; see the Snagboat output' : ''}.`);
    return;
  }
  const picked = await vscode.window.showQuickPick(items, {
    canPickMany: true,
    title: `Import ${items.length} rule${items.length === 1 ? '' : 's'} and categories${set.problems.length ? ` (${set.problems.length} invalid, listed in the output)` : ''}`,
    placeHolder: 'Pick what to add',
  });
  if (!picked || picked.length === 0) return;
  for (const item of picked) {
    await hooks.store.save(item.section, item.doc, { proposedBy: 'import', addedAt: hooks.now(), workspace: hooks.workspace, ...(item.replay ? { replay: item.replay } : {}) });
  }
  hooks.rulesChanged();
  void vscode.window.showInformationMessage(`Snagboat: imported ${picked.length} of ${items.length}.`);
}
