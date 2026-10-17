import * as vscode from 'vscode';
import * as crypto from 'crypto';
import { DetailState, isDetailMessage, resolveTargetFile } from './detailModel';

const UPDATE_DEBOUNCE_MS = 500;

export interface DetailPanelHooks {
  buildState(isOpenable: (target: string) => boolean): DetailState;
  acknowledge(heuristicId: string): void;
  setMuted(heuristicId: string, muted: boolean): void;
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

  constructor(private readonly extensionUri: vscode.Uri, private readonly hooks: DetailPanelHooks) {}

  show(): void {
    if (this.panel) {
      this.panel.reveal();
      return;
    }
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

  private postState(): void {
    if (!this.panel) return;
    void this.panel.webview.postMessage({ type: 'state', state: this.hooks.buildState(this.isOpenable) });
  }

  private async onMessage(message: unknown): Promise<void> {
    if (!isDetailMessage(message)) return;
    switch (message.type) {
      case 'ready':
        this.postState();
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
</body>
</html>`;
  }
}
