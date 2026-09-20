import * as crypto from 'crypto';
import { NormalizedEvent, EventTokens } from '../../core/types';

/**
 * Parses the OTLP/HTTP JSON wire format (a stable, documented protobuf-JSON
 * mapping: https://opentelemetry.io/docs/specs/otlp/). Span/metric names and
 * attribute names below are doc-verified against Microsoft's own monitoring
 * guide (https://code.visualstudio.com/docs/agents/guides/monitoring-agents)
 * and microsoft/vscode-copilot-chat's docs/monitoring/agent_monitoring.md --
 * not yet checked against a live capture of real exported traffic, the way
 * the claude-code hook payload shape was checked against a real one.
 *
 * Notably, `session.id` is a RESOURCE-level attribute (attached once per
 * resourceSpans/resourceMetrics entry), not a per-span/per-datapoint one --
 * reading it from the wrong level was an early bug here, caught by comparing
 * against the real docs instead of guessing.
 */

interface OtlpAttributeValue {
  stringValue?: string;
  intValue?: string | number;
  doubleValue?: number;
  boolValue?: boolean;
}

interface OtlpAttribute {
  key: string;
  value?: OtlpAttributeValue;
}

type AttrRecord = Record<string, string | number | boolean | undefined>;

function attrsToRecord(attrs?: OtlpAttribute[]): AttrRecord {
  const record: AttrRecord = {};
  for (const attr of attrs ?? []) {
    const v = attr.value;
    if (!v) continue;
    if (v.stringValue !== undefined) record[attr.key] = v.stringValue;
    else if (v.intValue !== undefined) record[attr.key] = Number(v.intValue);
    else if (v.doubleValue !== undefined) record[attr.key] = v.doubleValue;
    else if (v.boolValue !== undefined) record[attr.key] = v.boolValue;
  }
  return record;
}

function pickString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function pickNumber(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined;
}

interface OtlpResource {
  attributes?: OtlpAttribute[];
}

interface OtlpSpan {
  spanId?: string;
  name?: string;
  attributes?: OtlpAttribute[];
  status?: { code?: number };
}

interface OtlpTracesPayload {
  resourceSpans?: Array<{ resource?: OtlpResource; scopeSpans?: Array<{ spans?: OtlpSpan[] }> }>;
}

const SPAN_STATUS_OK = 1;
const SPAN_STATUS_ERROR = 2;

function spanStatus(span: OtlpSpan): NormalizedEvent['status'] {
  if (span.status?.code === SPAN_STATUS_ERROR) return 'failure';
  if (span.status?.code === SPAN_STATUS_OK) return 'success';
  return 'unknown';
}

function sessionIdFrom(attrs: AttrRecord): string {
  return pickString(attrs['session.id']) ?? pickString(attrs['gen_ai.conversation.id']) ?? 'unknown-session';
}

function modelFrom(attrs: AttrRecord): string | undefined {
  return pickString(attrs['gen_ai.request.model']) ?? pickString(attrs['gen_ai.response.model']);
}

/**
 * Maps spans to NormalizedEvents per the transformation matrix:
 * - `invoke_agent` carries the whole turn's token usage directly as span
 *   attributes (`gen_ai.usage.input_tokens`/`.output_tokens`) -- a simpler,
 *   more direct token source than the `gen_ai.client.token.usage` metric.
 * - `execute_tool`/`execute_hook` map to tool_call events (tool name comes
 *   from `gen_ai.tool.name` per the real GenAI semantic conventions).
 */
export function normalizeOtlpTraces(payload: unknown): NormalizedEvent[] {
  const events: NormalizedEvent[] = [];
  const resourceSpans = (payload as OtlpTracesPayload)?.resourceSpans ?? [];
  for (const rs of resourceSpans) {
    const resourceAttrs = attrsToRecord(rs.resource?.attributes);
    for (const ss of rs.scopeSpans ?? []) {
      for (const span of ss.spans ?? []) {
        const attrs = { ...resourceAttrs, ...attrsToRecord(span.attributes) };

        if (span.name === 'invoke_agent') {
          const tokens: EventTokens = {};
          const input = pickNumber(attrs['gen_ai.usage.input_tokens']);
          const output = pickNumber(attrs['gen_ai.usage.output_tokens']);
          if (input !== undefined) tokens.input = input;
          if (output !== undefined) tokens.output = output;

          events.push({
            eventId: crypto.randomUUID(),
            sessionId: sessionIdFrom(attrs),
            agent: 'copilot',
            ts: new Date().toISOString(),
            kind: 'turn_stop',
            status: spanStatus(span),
            model: modelFrom(attrs),
            tokens: Object.keys(tokens).length > 0 ? tokens : undefined,
            raw: { adapter: 'copilot', ref: `otlp:span:${span.spanId ?? 'unknown'}` },
          });
          continue;
        }

        if (span.name === 'execute_tool' || span.name === 'execute_hook') {
          const target =
            pickString(attrs['gen_ai.tool.name']) ?? pickString(attrs['tool_name']) ?? pickString(attrs['hook_type']);

          events.push({
            eventId: crypto.randomUUID(),
            sessionId: sessionIdFrom(attrs),
            agent: 'copilot',
            ts: new Date().toISOString(),
            kind: 'tool_call',
            target,
            status: spanStatus(span),
            model: modelFrom(attrs),
            raw: { adapter: 'copilot', ref: `otlp:span:${span.spanId ?? 'unknown'}` },
          });
        }
      }
    }
  }
  return events;
}

interface OtlpNumberDataPoint {
  attributes?: OtlpAttribute[];
  asInt?: string | number;
  asDouble?: number;
}

interface OtlpHistogramDataPoint {
  attributes?: OtlpAttribute[];
  sum?: number;
}

interface OtlpMetric {
  name?: string;
  sum?: { dataPoints?: OtlpNumberDataPoint[] };
  gauge?: { dataPoints?: OtlpNumberDataPoint[] };
  histogram?: { dataPoints?: OtlpHistogramDataPoint[] };
}

interface OtlpMetricsPayload {
  resourceMetrics?: Array<{ resource?: OtlpResource; scopeMetrics?: Array<{ metrics?: OtlpMetric[] }> }>;
}

function numberFromDataPoint(dp: OtlpNumberDataPoint): number {
  if (dp.asInt !== undefined) return Number(dp.asInt);
  if (dp.asDouble !== undefined) return dp.asDouble;
  return 0;
}

/**
 * Maps `gen_ai.client.token.usage` metric data points (confirmed a Histogram
 * in the real docs, but Sum/Gauge are handled defensively too) to turn_stop
 * events with tokens. This is a secondary token source alongside `invoke_agent`
 * spans -- both are kept since docs/architecture.md's redundant-path design
 * (used for claude-code hooks vs transcript) applies equally well here.
 */
export function normalizeOtlpMetrics(payload: unknown): NormalizedEvent[] {
  const events: NormalizedEvent[] = [];
  const resourceMetrics = (payload as OtlpMetricsPayload)?.resourceMetrics ?? [];
  for (const rm of resourceMetrics) {
    const resourceAttrs = attrsToRecord(rm.resource?.attributes);
    for (const sm of rm.scopeMetrics ?? []) {
      for (const metric of sm.metrics ?? []) {
        if (metric.name !== 'gen_ai.client.token.usage') continue;

        const points: Array<{ attrs?: OtlpAttribute[]; value: number }> = [
          ...(metric.sum?.dataPoints ?? []).map((dp) => ({ attrs: dp.attributes, value: numberFromDataPoint(dp) })),
          ...(metric.gauge?.dataPoints ?? []).map((dp) => ({ attrs: dp.attributes, value: numberFromDataPoint(dp) })),
          ...(metric.histogram?.dataPoints ?? []).map((dp) => ({ attrs: dp.attributes, value: dp.sum ?? 0 })),
        ];

        for (const point of points) {
          const attrs = { ...resourceAttrs, ...attrsToRecord(point.attrs) };
          const tokenType = pickString(attrs['gen_ai.token.type']);
          const tokens: EventTokens = tokenType === 'output' ? { output: point.value } : { input: point.value };

          events.push({
            eventId: crypto.randomUUID(),
            sessionId: sessionIdFrom(attrs),
            agent: 'copilot',
            ts: new Date().toISOString(),
            kind: 'turn_stop',
            status: 'unknown',
            model: modelFrom(attrs),
            tokens,
            raw: { adapter: 'copilot', ref: 'otlp:metric:gen_ai.client.token.usage' },
          });
        }
      }
    }
  }
  return events;
}
