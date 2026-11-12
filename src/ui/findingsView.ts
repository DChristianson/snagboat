import * as crypto from 'crypto';
import * as vscode from 'vscode';

/**
 * The compact findings panel (RFC step 5c, screen 4 of the design pass): a
 * view in Snagboat's own sidebar with the findings now, each with the advisor
 * it falls under and whether that advisor's hourly limit is holding it back,
 * a Useful button, today's totals, and links to the advisor UI (with the
 * per-user store on) and the detail view. The state is pushed whole; the page
 * draws it with textContent only.
 */

export interface CompactFinding {
  heuristicId: string;
  severity: 'info' | 'warn';
  summary: string;
  /** The advisor whose notify rules it falls under, by name. */
  advisor?: string;
  /** That advisor's notifications this hour are used up. */
  held: boolean;
  useful: boolean;
  acknowledged: boolean;
}

export interface CompactState {
  findings: CompactFinding[];
  today: { tokens: number; cacheRate?: number; milestones: number };
  /** The advisor UI is there to open (the window is the core's client). */
  advisorUi: boolean;
}

type ViewMessage = { type: 'ready' } | { type: 'useful'; heuristicId: string } | { type: 'openAdvisorUi' } | { type: 'openDetail' };

function isViewMessage(m: unknown): m is ViewMessage {
  if (!m || typeof m !== 'object') return false;
  const v = m as Record<string, unknown>;
  if (v.type === 'useful') return typeof v.heuristicId === 'string';
  return v.type === 'ready' || v.type === 'openAdvisorUi' || v.type === 'openDetail';
}

export interface FindingsViewHooks {
  state(): CompactState;
  useful(heuristicId: string): void;
  openAdvisorUi(): Promise<void>;
  openDetail(): void;
}

export class FindingsView implements vscode.WebviewViewProvider, vscode.Disposable {
  static readonly id = 'snagboat.findings';
  private view?: vscode.WebviewView;
  private pending?: NodeJS.Timeout;

  constructor(private readonly extensionUri: vscode.Uri, private readonly hooks: FindingsViewHooks) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    const media = vscode.Uri.joinPath(this.extensionUri, 'media');
    view.webview.options = { enableScripts: true, localResourceRoots: [media] };
    const nonce = crypto.randomBytes(16).toString('base64');
    const uri = (name: string) => view.webview.asWebviewUri(vscode.Uri.joinPath(media, name)).toString();
    view.webview.html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${view.webview.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${uri('findingsView.css')}">
</head>
<body>
<main id="root"></main>
<script nonce="${nonce}" src="${uri('findingsView.js')}"></script>
</body>
</html>`;
    view.webview.onDidReceiveMessage((m: unknown) => void this.onMessage(m));
    view.onDidChangeVisibility(() => view.visible && this.post());
    view.onDidDispose(() => {
      if (this.view === view) this.view = undefined;
    });
  }

  /** Coalesces bursts of changes into one push, only while the view can be seen. */
  scheduleUpdate(): void {
    if (!this.view?.visible || this.pending) return;
    this.pending = setTimeout(() => {
      this.pending = undefined;
      this.post();
    }, 250);
  }

  private post(): void {
    void this.view?.webview.postMessage({ type: 'state', state: this.hooks.state() });
  }

  private async onMessage(m: unknown): Promise<void> {
    if (!isViewMessage(m)) return;
    if (m.type === 'ready') this.post();
    else if (m.type === 'useful') {
      this.hooks.useful(m.heuristicId);
      this.post();
    } else if (m.type === 'openAdvisorUi') await this.hooks.openAdvisorUi();
    else if (m.type === 'openDetail') this.hooks.openDetail();
  }

  dispose(): void {
    if (this.pending) clearTimeout(this.pending);
  }
}
