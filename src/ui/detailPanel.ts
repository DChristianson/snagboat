import * as vscode from 'vscode';
import * as crypto from 'crypto';
import { DetailState, DetailTab, isDetailMessage, resolveTargetFile } from './detailModel';
import { SessionController } from './sessionController';
import { SuggestionsController } from './suggestionsController';

const UPDATE_DEBOUNCE_MS = 500;

export interface DetailPanelHooks {
  buildState(isOpenable: (target: string) => boolean): DetailState;
  acknowledge(heuristicId: string): void;
  setMuted(heuristicId: string, muted: boolean): void;
  sessions: SessionController;
  suggestions: SuggestionsController;
  /** Today's UTC day key, for the session list's default day. */
  today(): string;
}

/** Where to take the page when opening it from a link or command. */
export interface DetailTarget {
  tab?: DetailTab;
  day?: string;
  sessionId?: string;
}

function workspaceRoots(): string[] {
  return (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
}

/**
 * The single detail webview. State is pushed whole (it's small: at most
 * TIMELINE_LIMIT events plus per-day totals) and only while the panel is
 * visible; becoming visible again triggers a fresh push.
 */
export class DetailPanel implements vscode.Disposable {
  private panel?: vscode.WebviewPanel;
  private pendingUpdate?: NodeJS.Timeout;
  // Targets repeat heavily (the same file edited many times), so one stat per
  // distinct target per panel session is plenty.
  private openableCache = new Map<string, boolean>();
  private activeTab: DetailTab = 'overview';
  private sessionDay?: string;

  constructor(private readonly extensionUri: vscode.Uri, private readonly hooks: DetailPanelHooks) {
    hooks.suggestions.onChange(() => this.postSuggestions());
  }

  show(target?: DetailTarget): void {
    if (this.panel) {
      this.panel.reveal();
      if (target) void this.navigate(target);
      return;
    }
    this.pendingTarget = target;
    const mediaRoot = vscode.Uri.joinPath(this.extensionUri, 'media');
    const panel = vscode.window.createWebviewPanel('snagboat.detail', 'Snagboat', vscode.ViewColumn.Active, {
      enableScripts: true,
      localResourceRoots: [mediaRoot],
    });
    this.panel = panel;
    this.openableCache.clear();
    panel.webview.html = this.html(panel.webview, mediaRoot);
    panel.onDidDispose(() => {
      this.panel = undefined;
      clearTimeout(this.pendingUpdate);
    });
    panel.onDidChangeViewState(() => {
      if (panel.visible) this.postState();
    });
    panel.webview.onDidReceiveMessage((message: unknown) => this.onMessage(message));
  }

  /** Called on every model change; coalesced, and skipped entirely while hidden. */
  scheduleUpdate(): void {
    if (!this.panel?.visible || this.pendingUpdate) return;
    this.pendingUpdate = setTimeout(() => {
      this.pendingUpdate = undefined;
      this.postState();
    }, UPDATE_DEBOUNCE_MS);
  }

  dispose(): void {
    this.panel?.dispose();
  }

  private isOpenable = (target: string): boolean => {
    let openable = this.openableCache.get(target);
    if (openable === undefined) {
      openable = resolveTargetFile(target, workspaceRoots()) !== undefined;
      this.openableCache.set(target, openable);
    }
    return openable;
  };

  private pendingTarget?: DetailTarget;

  private postState(): void {
    if (!this.panel) return;
    void this.panel.webview.postMessage({ type: 'state', state: this.hooks.buildState(this.isOpenable) });
    if (this.activeTab === 'sessions') this.postSessions();
    if (this.activeTab === 'suggestions') this.postSuggestions();
  }

  private postSuggestions(): void {
    if (!this.panel || this.activeTab !== 'suggestions') return;
    void this.panel.webview.postMessage({ type: 'suggestions', view: this.hooks.suggestions.view() });
  }

  private postSessions(): void {
    if (!this.panel) return;
    void this.panel.webview.postMessage({ type: 'sessions', list: this.hooks.sessions.list(this.sessionDay, this.hooks.today()) });
    const view = this.hooks.sessions.view();
    if (view) void this.panel.webview.postMessage({ type: 'session', view });
  }

  /** Switches tab, day, and session, then tells the page where it is. */
  private async navigate(target: DetailTarget): Promise<void> {
    if (target.tab) this.activeTab = target.tab;
    if (target.sessionId) {
      this.activeTab = 'sessions';
      const view = await this.hooks.sessions.open(target.sessionId);
      if (view && !target.day) this.sessionDay = view.summary.days[view.summary.days.length - 1];
    }
    if (target.day) this.sessionDay = target.day;
    void this.panel?.webview.postMessage({ type: 'navigate', tab: this.activeTab, sessionId: this.hooks.sessions.openSessionId });
    this.postState();
  }

  private async onMessage(message: unknown): Promise<void> {
    if (!isDetailMessage(message)) return;
    switch (message.type) {
      case 'ready':
        if (this.pendingTarget) {
          const target = this.pendingTarget;
          this.pendingTarget = undefined;
          await this.navigate(target);
        } else {
          this.postState();
        }
        break;
      case 'tab':
        this.activeTab = message.tab;
        if (message.tab === 'sessions') this.postSessions();
        if (message.tab === 'suggestions') {
          this.postSuggestions();
          // The first visit runs discovery; after that, only Discover again does.
          if (!this.hooks.suggestions.hasRun) void this.hooks.suggestions.discover();
        }
        break;
      case 'discover':
        await this.hooks.suggestions.discover();
        break;
      case 'tweakSuggestion':
        this.hooks.suggestions.tweak(message.id, message.threshold);
        break;
      case 'acceptSuggestion':
        await this.hooks.suggestions.accept(message.id);
        break;
      case 'acceptShellCategory':
        await this.hooks.suggestions.acceptCategory(message.id);
        break;
      case 'dismissSuggestion':
        await this.hooks.suggestions.dismiss(message.id);
        break;
      case 'clearDismissed':
        await this.hooks.suggestions.clearDismissed();
        break;
      case 'applyThreshold':
        await this.hooks.suggestions.applyThreshold(message.heuristic, message.setting);
        break;
      case 'removeSaved':
        await this.hooks.suggestions.removeSaved(message.section, message.id);
        break;
      case 'listSessions':
        this.sessionDay = message.day;
        this.postSessions();
        break;
      case 'openSession':
        await this.navigate({ sessionId: message.sessionId, day: this.sessionDay });
        break;
      case 'closeSession':
        this.hooks.sessions.close();
        void this.panel?.webview.postMessage({ type: 'session', view: null });
        break;
      case 'acknowledge':
        this.hooks.acknowledge(message.heuristicId);
        break;
      case 'setMuted':
        this.hooks.setMuted(message.heuristicId, message.muted);
        break;
      case 'openFile': {
        // The webview is only trusted to name a target; it opens only if that
        // resolves to an existing file, never a directory or arbitrary URI.
        const file = resolveTargetFile(message.target, workspaceRoots());
        if (file) {
          await vscode.window.showTextDocument(vscode.Uri.file(file), { preview: true, viewColumn: vscode.ViewColumn.One });
        } else {
          void vscode.window.showWarningMessage(`Snagboat: ${message.target} is no longer on disk.`);
        }
        break;
      }
    }
  }

  private html(webview: vscode.Webview, mediaRoot: vscode.Uri): string {
    const nonce = crypto.randomBytes(16).toString('base64');
    const script = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'detail.js'));
    const sessionsScript = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'sessions.js'));
    const suggestionsScript = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'suggestions.js'));
    const style = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'detail.css'));
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${style}">
<title>Snagboat</title>
</head>
<body>
<main id="app" aria-live="polite"><p class="muted">Loading…</p></main>
<div id="tooltip" class="tooltip" role="tooltip" hidden></div>
<script nonce="${nonce}" src="${script}"></script>
<script nonce="${nonce}" src="${sessionsScript}"></script>
<script nonce="${nonce}" src="${suggestionsScript}"></script>
</body>
</html>`;
  }
}
