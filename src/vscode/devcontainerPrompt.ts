import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { containersAllowed, loadConfig, saveConfig, withContainerFolder } from '../core/config';
import { applyDevcontainerPlan, describePlan, DevcontainerPlan, planDevcontainer, unifiedDiff } from '../core/devcontainerSetup';
import { snagboatHome } from '../core/userStore';

/**
 * In a window on this machine (not one already in a container), offers to set up a workspace folder's dev container
 * so the core reads the Claude Code sessions run in it (snagboat-05p): what `snagboat containers allow --edit` does,
 * from a notification. Asked once per folder, whatever the answer; the "Snagboat: Set Up Dev Container" command
 * asks again. It writes the personal config only (never the shared devcontainer.json; the CLI's --in-place does that).
 */
const ASKED_KEY = 'snagboat.devcontainerAsked';

export function registerDevcontainerSetup(context: vscode.ExtensionContext): vscode.Disposable[] {
  const command = vscode.commands.registerCommand('snagboat.setUpDevContainer', async () => {
    const folders = candidates();
    if (folders.length === 0) {
      void vscode.window.showInformationMessage(
        vscode.env.remoteName
          ? 'Snagboat: set up the dev container from a window on this machine, not one in the container.'
          : 'Snagboat: no workspace folder here has a devcontainer.json.'
      );
      return;
    }
    const pick =
      folders.length === 1
        ? folders[0]
        : (await vscode.window.showQuickPick(
            folders.map((f) => ({ label: path.basename(f.folder), description: describePlan(f.plan), f })),
            { placeHolder: 'Which folder\'s dev container?' }
          ))?.f;
    if (!pick) return;
    if (pick.plan.state !== 'changes') {
      void vscode.window.showInformationMessage(`Snagboat: ${path.basename(pick.folder)}'s dev container is ${describePlan(pick.plan)}.`);
      if (pick.plan.state === 'ready') {
        try {
          allow(pick.folder);
        } catch (err) {
          void vscode.window.showErrorMessage(`Snagboat: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      return;
    }
    await offer(context, pick.folder, pick.plan, true);
  });
  // Don't hold up activation: look once the window has settled.
  const timer = setTimeout(() => {
    const asked = context.globalState.get<string[]>(ASKED_KEY, []);
    for (const c of candidates()) {
      if (c.plan.state !== 'changes' || asked.includes(c.folder)) continue;
      // Only an ignore line or a missing folder: not worth a notification (status and the command still show it).
      if (!c.plan.writesConfig && !(c.plan.createsTranscriptsDir && containersAllowed(loadConfig(snagboatHome()).config).includes(c.folder))) continue;
      void offer(context, c.folder, c.plan, false);
      break; // one at a time
    }
  }, 5_000);
  return [command, { dispose: () => clearTimeout(timer) }];
}

/** Workspace folders on this machine with a devcontainer.json, and what each still needs. */
function candidates(): Array<{ folder: string; plan: DevcontainerPlan }> {
  if (vscode.env.remoteName) return [];
  const out: Array<{ folder: string; plan: DevcontainerPlan }> = [];
  for (const wf of vscode.workspace.workspaceFolders ?? []) {
    if (wf.uri.scheme !== 'file') continue;
    try {
      const folder = fs.realpathSync(wf.uri.fsPath);
      const plan = planDevcontainer(folder);
      if (plan) out.push({ folder, plan });
    } catch {
      // A folder that's gone, or a config that can't be read: nothing to offer.
    }
  }
  return out;
}

async function offer(context: vscode.ExtensionContext, folder: string, plan: DevcontainerPlan, asked: boolean): Promise<void> {
  if (!asked) {
    const seen = context.globalState.get<string[]>(ASKED_KEY, []);
    await context.globalState.update(ASKED_KEY, [...seen.filter((f) => f !== folder), folder]);
  }
  const name = path.basename(folder);
  const message =
    `Snagboat: Claude Code sessions in ${name}'s dev container stay in the container, so Snagboat doesn't see them. ` +
    `Set it up? Snagboat writes a personal dev container config that git ignores in this clone only (your shared devcontainer.json isn't changed), and reads the sessions from .snagboat/claude-projects.`;
  for (;;) {
    const choice = await vscode.window.showInformationMessage(message, 'Set Up', 'Show Changes', ...(asked ? [] : ['Not Now']));
    if (choice === 'Show Changes') {
      const rel = (p: string) => path.relative(folder, p).split(path.sep).join('/');
      const lines = [...plan.changes.map((c) => `# + ${c}`)];
      if (plan.createsTranscriptsDir) lines.push(`# + create ${rel(plan.transcriptsDir)}/`);
      if (plan.ignoreLines.length && plan.ignoreFile) lines.push(`# + add ${plan.ignoreLines.join(' and ')} to ${rel(plan.ignoreFile)}`);
      for (const n of plan.notes) lines.push(`# note: ${n.replace(/\n/g, '\n# ')}`);
      if (plan.writesConfig) lines.push('', unifiedDiff(plan.before, plan.after, `a/${rel(plan.beforePath)}`, `b/${rel(plan.outPath)}`));
      await vscode.window.showTextDocument(await vscode.workspace.openTextDocument({ language: 'diff', content: lines.join('\n') }), { preview: true });
      continue;
    }
    if (choice !== 'Set Up') return;
    break;
  }
  let wrote: string[];
  try {
    // Check again: the files may have changed while the notification was up.
    const fresh = planDevcontainer(folder);
    if (!fresh || fresh.state === 'refused') {
      void vscode.window.showWarningMessage(`Snagboat: didn't change anything. ${fresh?.problem ?? 'The devcontainer.json is gone.'} (snagboat containers allow --edit in a terminal says more.)`);
      return;
    }
    wrote = applyDevcontainerPlan(fresh);
    allow(folder);
    plan = fresh;
  } catch (err) {
    void vscode.window.showErrorMessage(`Snagboat: couldn't set up the dev container: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  const reopen = plan.writesConfig && plan.personalName ? 'Reopen in Container' : undefined;
  const done = await vscode.window.showInformationMessage(
    `Snagboat: ${wrote.join('; ')}. ${plan.personalName ? `Reopen in the container and pick "${plan.personalName}"; it has its own Claude Code login. ` : ''}` +
      'Sessions the container kept so far stay where they were; scripts/devcontainerSetup.js in a snagboat checkout carries them over.',
    ...(reopen ? [reopen] : [])
  );
  if (done === reopen) void vscode.commands.executeCommand('remote-containers.reopenInContainer');
}

/** Adds the folder to containers.allow in ~/.snagboat/config.json, as `snagboat containers allow` does. */
function allow(folder: string): void {
  const home = snagboatHome();
  const { config, problems } = loadConfig(home);
  if (problems.some((p) => p.includes("isn't valid JSON"))) throw new Error(`${path.join(home, 'config.json')} isn't valid JSON: fix it, then run Snagboat: Set Up Dev Container again`);
  if (!containersAllowed(config).includes(folder)) saveConfig(home, withContainerFolder(config, folder, true));
}
