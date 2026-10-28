import * as fs from 'fs';
import * as path from 'path';
import { AggregateSnapshot } from '../core/aggregate';
import { DailyTokens } from '../core/dailyHistory';
import { NormalizedEvent } from '../core/types';
import { FindingView } from '../heuristics/findingsRegistry';
import { agentEventTotal } from './format';
import { toolCategoryLabel } from '../core/toolCategory';

/** Newest events sent to the timeline; the store's own window caps it further (24h). */
export const TIMELINE_LIMIT = 1000;

export interface TimelineEvent {
  id: string;
  ts: string;
  agent: string;
  kind: string;
  status: string;
  sessionId: string;
  target?: string;
  tokens?: number;
  textExcerpt?: string;
  /** Prompts only: the prompt's text, when text capture is on. */
  promptText?: string;
  /** The session's name, when one was captured. */
  sessionName?: string;
  /** Tool calls only: e.g. "Tests and builds", "MCP: github". */
  toolLabel?: string;
  /** True when target resolves to a file on disk, so the view can offer jump-to-file. */
  openable: boolean;
}

export interface FindingItem {
  heuristicId: string;
  severity: 'info' | 'warn';
  summary: string;
  suggestedAction?: string;
  detectedAt: string;
  eventRefs: string[];
  /** The session most of its events belong to, for "Show in session". */
  sessionId?: string;
  acknowledged: boolean;
  muted: boolean;
}

/** Everything the webview renders, sent whole on each update. */
export interface DetailState {
  generatedAt: string;
  /** Whether snagboat.captureContent is on, and how long excerpts are kept (rawDays). */
  capture: { enabled: boolean; retentionDays: number };
  today: { tokens: number; events: number; edits: number };
  timeline: { events: TimelineEvent[]; truncated: boolean };
  findings: FindingItem[];
  muted: string[];
  daily: DailyTokens[];
}

/** Messages the webview sends back to the extension. */
export type DetailMessage =
  | { type: 'ready' }
  | { type: 'acknowledge'; heuristicId: string }
  | { type: 'setMuted'; heuristicId: string; muted: boolean }
  | { type: 'openFile'; target: string }
  | { type: 'tab'; tab: DetailTab }
  | { type: 'listSessions'; day?: string }
  | { type: 'openSession'; sessionId: string }
  | { type: 'closeSession' }
  | { type: 'discover' }
  | { type: 'tweakSuggestion'; id: string; threshold: number }
  | { type: 'acceptSuggestion'; id: string }
  | { type: 'acceptShellCategory'; id: string }
  | { type: 'dismissSuggestion'; id: string }
  | { type: 'clearDismissed' }
  | { type: 'applyThreshold'; heuristic: string; setting: string }
  | { type: 'removeSaved'; section: 'rules' | 'categories'; id: string };

export type DetailTab = 'overview' | 'sessions' | 'suggestions';

export function isDetailMessage(value: unknown): value is DetailMessage {
  if (typeof value !== 'object' || value === null) return false;
  const m = value as Record<string, unknown>;
  switch (m.type) {
    case 'ready':
      return true;
    case 'acknowledge':
      return typeof m.heuristicId === 'string';
    case 'setMuted':
      return typeof m.heuristicId === 'string' && typeof m.muted === 'boolean';
    case 'openFile':
      return typeof m.target === 'string';
    case 'tab':
      return m.tab === 'overview' || m.tab === 'sessions' || m.tab === 'suggestions';
    case 'listSessions':
      return m.day === undefined || (typeof m.day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(m.day));
    case 'openSession':
      return typeof m.sessionId === 'string';
    case 'closeSession':
    case 'discover':
    case 'clearDismissed':
      return true;
    case 'tweakSuggestion':
      return typeof m.id === 'string' && typeof m.threshold === 'number' && Number.isFinite(m.threshold) && m.threshold > 0;
    case 'acceptSuggestion':
    case 'acceptShellCategory':
    case 'dismissSuggestion':
      return typeof m.id === 'string';
    case 'applyThreshold':
      return typeof m.heuristic === 'string' && typeof m.setting === 'string';
    case 'removeSaved':
      return (m.section === 'rules' || m.section === 'categories') && typeof m.id === 'string';
    default:
      return false;
  }
}

/**
 * Resolves an event target to an existing file: absolute paths as-is, relative
 * ones against each workspace root in order. Anything else (shell commands,
 * tool names, missing files, directories) resolves to undefined.
 */
export function resolveTargetFile(target: string, roots: string[]): string | undefined {
  if (!target || target.length > 1024 || /[\r\n]/.test(target)) return undefined;
  const candidates = path.isAbsolute(target) ? [target] : roots.map((root) => path.join(root, target));
  for (const candidate of candidates) {
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      // not there; try the next root
    }
  }
  return undefined;
}

function eventTokens(event: NormalizedEvent): number | undefined {
  if (!event.tokens) return undefined;
  const { input = 0, output = 0, cacheRead = 0, cacheCreation = 0 } = event.tokens;
  return input + output + cacheRead + cacheCreation;
}

function dominantSession(refs: string[], sessionOf: Map<string, string>): string | undefined {
  const counts = new Map<string, number>();
  for (const id of refs) {
    const s = sessionOf.get(id);
    if (s) counts.set(s, (counts.get(s) ?? 0) + 1);
  }
  return [...counts].sort((a, b) => b[1] - a[1])[0]?.[0];
}

export function buildDetailState(inputs: {
  now: string;
  capture: { enabled: boolean; retentionDays: number };
  today: AggregateSnapshot;
  recentEvents: NormalizedEvent[];
  findings: FindingView[];
  muted: string[];
  daily: DailyTokens[];
  isOpenable: (target: string) => boolean;
  sessionName?: (sessionId: string) => string | undefined;
}): DetailState {
  // A session's name is metadata, shown in the session column rather than as an event of its own.
  const shown = inputs.recentEvents.filter((e) => e.kind !== 'session_name');
  const newest = shown.slice(-TIMELINE_LIMIT).reverse();
  const sessionOf = new Map(inputs.recentEvents.map((e) => [e.eventId, e.sessionId]));
  return {
    generatedAt: inputs.now,
    capture: inputs.capture,
    today: {
      tokens: inputs.today.totalTokens,
      events: agentEventTotal(inputs.today),
      edits: inputs.today.localEditCount,
    },
    timeline: {
      truncated: shown.length > TIMELINE_LIMIT,
      events: newest.map((e) => ({
        id: e.eventId,
        ts: e.ts,
        agent: e.agent,
        kind: e.kind,
        status: e.status,
        sessionId: e.sessionId,
        target: e.target,
        tokens: eventTokens(e),
        textExcerpt: e.textExcerpt,
        promptText: e.promptText,
        sessionName: inputs.sessionName?.(e.sessionId),
        toolLabel: e.toolCategory ? toolCategoryLabel(e.toolCategory, e.toolName) : undefined,
        openable: e.target !== undefined && inputs.isOpenable(e.target),
      })),
    },
    findings: inputs.findings.map(({ finding, acknowledged, muted }) => ({
      sessionId: dominantSession(finding.eventRefs, sessionOf),
      heuristicId: finding.heuristicId,
      severity: finding.severity,
      summary: finding.summary,
      suggestedAction: finding.suggestedAction,
      detectedAt: finding.detectedAt,
      eventRefs: finding.eventRefs,
      acknowledged,
      muted,
    })),
    muted: inputs.muted,
    daily: inputs.daily,
  };
}
