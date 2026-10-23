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
  | { type: 'tab'; tab: 'overview' | 'sessions' }
  | { type: 'listSessions'; day?: string }
  | { type: 'openSession'; sessionId: string }
  | { type: 'closeSession' };

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
      return m.tab === 'overview' || m.tab === 'sessions';
    case 'listSessions':
      return m.day === undefined || (typeof m.day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(m.day));
    case 'openSession':
      return typeof m.sessionId === 'string';
    case 'closeSession':
      return true;
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

export function buildDetailState(inputs: {
  now: string;
  capture: { enabled: boolean; retentionDays: number };
  today: AggregateSnapshot;
  recentEvents: NormalizedEvent[];
  findings: FindingView[];
  muted: string[];
  daily: DailyTokens[];
  isOpenable: (target: string) => boolean;
}): DetailState {
  const newest = inputs.recentEvents.slice(-TIMELINE_LIMIT).reverse();
  return {
    generatedAt: inputs.now,
    capture: inputs.capture,
    today: {
      tokens: inputs.today.totalTokens,
      events: agentEventTotal(inputs.today),
      edits: inputs.today.localEditCount,
    },
    timeline: {
      truncated: inputs.recentEvents.length > TIMELINE_LIMIT,
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
        toolLabel: e.toolCategory ? toolCategoryLabel(e.toolCategory, e.toolName) : undefined,
        openable: e.target !== undefined && inputs.isOpenable(e.target),
      })),
    },
    findings: inputs.findings.map(({ finding, acknowledged, muted }) => ({
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
