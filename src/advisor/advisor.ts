import * as vscode from 'vscode';
import { AuditLog } from './audit';
import { buildDigest, DigestInput } from './digest';
import { ExplainFocus, explainMessages } from './explain';
import { approvalKey, ChatMessage, complete, completionBody, Completion, FetchLike, listModels, parseProviders, promptWasCut, ProviderConfig } from './providers';

const APPROVED_KEY = 'snagboat.advisor.approved';
const secretKey = (id: string) => `snagboat.advisor.key.${id}`;

export interface AdvisorDeps {
  secrets: vscode.SecretStorage;
  globalState: vscode.Memento;
  audit: AuditLog;
  output: vscode.OutputChannel;
  /** A stored session (optionally one turn) as digest input; undefined if it's gone. */
  digestInput(sessionId: string, turnId?: string): Promise<DigestInput | undefined>;
}

export type Capability = 'explain' | 'propose' | 'review';

/** An answer, with the provider (and model) that gave it and what it was asked. */
export interface Asked {
  completion: Completion;
  provider: ProviderConfig;
  messages: ChatMessage[];
}

/** What Explain was asked about, from the Sessions tab or a command. */
export interface ExplainRequest {
  sessionId: string;
  turnId?: string;
  heuristicId?: string;
}

function config(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration('snagboat.advisor');
}

/**
 * The advisor's VS Code side: picks the provider for a capability, gets its
 * key from SecretStorage, shows the exact payload before a provider's first
 * request, audits hosted requests, and shows answers labelled as model output.
 */
export class Advisor {
  constructor(private readonly deps: AdvisorDeps, private readonly fetchImpl: FetchLike = fetch as unknown as FetchLike) {}

  providers(): ProviderConfig[] {
    const { providers, problems } = parseProviders(config().get('providers'));
    for (const p of problems) this.deps.output.appendLine(`Advisor: ${p}`);
    return providers;
  }

  private async provider(capability: Capability): Promise<ProviderConfig | undefined> {
    const id = config().get<string>(`${capability}Provider`, 'local');
    const p = this.providers().find((x) => x.id === id);
    if (!p) {
      void vscode.window.showErrorMessage(`Snagboat: no advisor provider "${id}" in snagboat.advisor.providers.`, 'Open Settings').then((c) => c && vscode.commands.executeCommand('workbench.action.openSettings', 'snagboat.advisor'));
      return undefined;
    }
    return p;
  }

  private async apiKey(p: ProviderConfig): Promise<string | undefined | null> {
    if (p.kind === 'local') return undefined;
    const key = await this.deps.secrets.get(secretKey(p.id));
    if (key) return key;
    const choice = await vscode.window.showWarningMessage(`Snagboat: ${p.label} needs your API key before anything is sent.`, 'Set API Key');
    if (choice) await this.setKey(p.id);
    return null;
  }

  /** Snagboat: Set Advisor API Key: stores a hosted provider's key in VS Code's SecretStorage. */
  async setKey(providerId?: string): Promise<void> {
    const hosted = this.providers().filter((p) => p.kind === 'hosted');
    if (hosted.length === 0) {
      void vscode.window.showInformationMessage('Snagboat: no hosted providers are configured; add one to snagboat.advisor.providers. Local providers need no key.');
      return;
    }
    const p = providerId ? hosted.find((x) => x.id === providerId) : (await vscode.window.showQuickPick(hosted.map((x) => ({ label: x.label, description: x.baseUrl, p: x })), { placeHolder: 'Which provider?' }))?.p;
    if (!p) return;
    const key = await vscode.window.showInputBox({ prompt: `API key for ${p.label} (${p.baseUrl}); kept in VS Code's secret storage`, password: true, ignoreFocusOut: true });
    if (key === undefined) return;
    if (key.trim()) await this.deps.secrets.store(secretKey(p.id), key.trim());
    else await this.deps.secrets.delete(secretKey(p.id));
    void vscode.window.showInformationMessage(`Snagboat: ${key.trim() ? 'saved' : 'removed'} the API key for ${p.label}.`);
  }

  /** Lets you pick from the provider's models when none is set, and saves the choice where the providers are set. */
  private async model(p: ProviderConfig, apiKey: string | undefined): Promise<string | undefined> {
    if (p.model) return p.model;
    let models: string[];
    try {
      models = await listModels(p, apiKey, this.fetchImpl);
    } catch (err) {
      void vscode.window.showErrorMessage(`Snagboat: couldn't list ${p.label}'s models (${p.baseUrl}): ${err instanceof Error ? err.message : String(err)}. Is it running? You can also set "model" in snagboat.advisor.providers.`);
      return undefined;
    }
    if (models.length === 0) {
      void vscode.window.showErrorMessage(`Snagboat: ${p.label} has no models. For Ollama, pull one first (ollama pull <model>).`);
      return undefined;
    }
    const model = await vscode.window.showQuickPick(models, { placeHolder: `Which ${p.label} model should the advisor use?` });
    if (!model) return undefined;
    const inspected = config().inspect<unknown[]>('providers');
    const target = inspected?.workspaceValue !== undefined ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
    const current = (target === vscode.ConfigurationTarget.Workspace ? inspected?.workspaceValue : inspected?.globalValue ?? inspected?.defaultValue) ?? [];
    await config().update('providers', (current as Array<Record<string, unknown>>).map((x) => (x.id === p.id ? { ...x, model } : x)), target);
    return model;
  }

  /** Before a provider's first request (or after its URL or sending rules change), shows the payload and asks. */
  private async approved(p: ProviderConfig, body: string): Promise<boolean> {
    const approvals = this.deps.globalState.get<Record<string, string>>(APPROVED_KEY, {});
    if (approvals[p.id] === approvalKey(p)) return true;
    const doc = await vscode.workspace.openTextDocument({ language: 'json', content: JSON.stringify(JSON.parse(body), null, 2) });
    await vscode.window.showTextDocument(doc, { preview: true, viewColumn: vscode.ViewColumn.Beside });
    const where = p.kind === 'local' ? 'a model on this machine' : `${p.baseUrl}, off this machine`;
    const choice = await vscode.window.showWarningMessage(
      `Send this to ${p.label}?`,
      {
        modal: true,
        detail: `The open document is exactly what will be sent to ${where}. This is the first request with ${p.label}'s current address and sending rules; you won't be asked again until they change. Snagboat: Preview Advisor Digest shows a payload any time.`,
      },
      'Send'
    );
    if (choice !== 'Send') return false;
    await this.deps.globalState.update(APPROVED_KEY, { ...approvals, [p.id]: approvalKey(p) });
    return true;
  }

  /**
   * One request for a capability: the provider set for it, its key and model,
   * your approval of the exact payload, then the answer, audited if hosted.
   * Undefined when you stopped it or it failed (already reported).
   */
  async ask(
    capability: Capability,
    build: (p: ProviderConfig) => Promise<ChatMessage[] | undefined>,
    opts: { title: string; json?: boolean }
  ): Promise<Asked | undefined> {
    const p = await this.provider(capability);
    if (!p) return undefined;
    const apiKey = await this.apiKey(p);
    if (apiKey === null) return undefined;
    const model = await this.model(p, apiKey);
    if (!model) return undefined;
    const messages = await build(p);
    if (!messages) return undefined;
    const body = completionBody(model, messages, opts.json);
    if (!(await this.approved(p, body))) return undefined;
    const provider = { ...p, model };
    try {
      const completion = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Snagboat: ${opts.title} with ${p.label} (${model})…`, cancellable: false }, () =>
        complete(provider, messages, apiKey, this.fetchImpl, opts.json)
      );
      await this.auditRequest(provider, capability, body, 'ok');
      return { completion, provider, messages };
    } catch (err) {
      await this.auditRequest(provider, capability, body, 'error');
      void vscode.window.showErrorMessage(`Snagboat: ${p.label} (${p.baseUrl}) didn't answer: ${err instanceof Error ? err.message : String(err)}`);
      return undefined;
    }
  }

  /** A warning to show above an answer whose prompt the server cut to fit its context window, or ''. */
  static cutWarning(asked: Asked, smaller: string): string {
    const { completion, provider: p, messages } = asked;
    if (!promptWasCut(completion, messages)) return '';
    return `${p.label} read only ${completion.promptTokens?.toLocaleString()} tokens of a longer request, so it saw only part of it and may miss things. Its context window is too small: ${p.kind === 'local' ? 'for Ollama, restart it with a larger one (for example `OLLAMA_CONTEXT_LENGTH=16384 ollama serve`), or ' : ''}${smaller}.`;
  }

  async explain(req: ExplainRequest): Promise<void> {
    let focus: ExplainFocus = { kind: 'session' };
    let gone = false;
    const asked = await this.ask(
      'explain',
      async (p) => {
        const input = await this.deps.digestInput(req.sessionId, req.turnId);
        if (!input) {
          gone = true;
          return undefined;
        }
        const digest = buildDigest(input, p.policy);
        if (req.heuristicId) focus = { kind: 'finding', heuristicId: req.heuristicId, summary: digest.findings.find((f) => f.heuristic === req.heuristicId)?.summary ?? '' };
        else if (req.turnId) focus = { kind: 'turn', turn: digest.turns[0]?.turn ?? 0 };
        return explainMessages(digest, focus);
      },
      { title: 'explaining' }
    );
    if (gone) void vscode.window.showWarningMessage('Snagboat: that session is no longer in the log.');
    if (!asked) return;
    const f = focus as ExplainFocus;
    const about = f.kind === 'session' ? 'this session' : f.kind === 'turn' ? `turn ${f.turn}` : `the ${f.heuristicId} finding`;
    const header = `> **Model output** from ${asked.provider.label}, model \`${asked.provider.model}\`, ${new Date().toLocaleString()}. Explaining ${about} of session \`${req.sessionId.slice(0, 8)}\` from Snagboat's digest. It's a suggestion: check it against the session.\n\n`;
    const cut = Advisor.cutWarning(asked, 'explain a turn or finding instead, which sends much less');
    const doc = await vscode.workspace.openTextDocument({ language: 'markdown', content: header + (cut ? `> **Warning:** ${cut}\n\n` : '') + asked.completion.text + '\n' });
    await vscode.window.showTextDocument(doc, { preview: false, viewColumn: vscode.ViewColumn.Beside });
  }

  private async auditRequest(p: ProviderConfig, capability: Capability, body: string, outcome: 'ok' | 'error'): Promise<void> {
    if (p.kind !== 'hosted') return;
    const entry = AuditLog.entryFor(body, { ts: new Date().toISOString(), provider: p.id, baseUrl: p.baseUrl, model: p.model, capability, outcome }, config().get<boolean>('auditPayloads', false));
    await this.deps.audit.append(entry).catch((err) => this.deps.output.appendLine(`Advisor: couldn't write the audit log: ${String(err)}`));
  }
}
