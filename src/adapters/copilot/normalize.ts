import * as crypto from 'crypto';
import { NormalizedEvent, EventTokens } from '../../core/types';
import { makeExcerpt } from '../../core/excerpt';
import { classifyTool } from '../../core/toolCategory';

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
  parentSpanId?: string;
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
 * Extracts assistant text parts from `gen_ai.output.messages`, a JSON string
 * that Copilot only sets when its own github.copilot.chat.otel.captureContent
 * is on. Shape per the OpenTelemetry GenAI conventions' output-messages schema
 * (semantic-conventions-genai, model/gen-ai/gen-ai-output-messages.json):
 * `[{ role: 'assistant', parts: [{ type: 'text', content: '...' }], finish_reason }]`.
 * Reasoning and other part types are skipped.
 */
function assistantTextFrom(attrs: AttrRecord): string | undefined {
  const raw = pickString(attrs['gen_ai.output.messages']);
  if (!raw) return undefined;
  let messages: unknown;
  try {
    messages = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!Array.isArray(messages)) return undefined;
  const texts: Array<string | undefined> = [];
  for (const message of messages as Array<{ role?: unknown; parts?: unknown }>) {
    if (message?.role !== 'assistant' || !Array.isArray(message.parts)) continue;
    for (const part of message.parts as Array<{ type?: unknown; content?: unknown }>) {
      if (part?.type === 'text') texts.push(pickString(part.content));
    }
  }
  return makeExcerpt(texts);
}

/**
 * Maps spans to NormalizedEvents per the transformation matrix:
 * - `invoke_agent` carries the whole turn's token usage directly as span
 *   attributes (`gen_ai.usage.input_tokens`/`.output_tokens`) -- a simpler,
 *   more direct token source than the `gen_ai.client.token.usage` metric.
 * - `execute_tool`/`execute_hook` map to tool_call events (tool name comes
 *   from `gen_ai.tool.name` per the real GenAI semantic conventions).
 */
export function normalizeOtlpTraces(payload: unknown, opts: { captureContent?: boolean } = {}): NormalizedEvent[] {
  const events: NormalizedEvent[] = [];
  const resourceSpans = (payload as OtlpTracesPayload)?.resourceSpans ?? [];
  for (const rs of resourceSpans) {
    const resourceAttrs = attrsToRecord(rs.resource?.attributes);
    const agentSpanIds = new Set(
      (rs.scopeSpans ?? []).flatMap((ss) => (ss.spans ?? []).filter((s) => s.name === 'invoke_agent' && s.spanId).map((s) => s.spanId!))
    );
    for (const ss of rs.scopeSpans ?? []) {
      for (const span of ss.spans ?? []) {
        const attrs = { ...resourceAttrs, ...attrsToRecord(span.attributes) };

        // "chat <model>": one model call. Outside an agent turn these are editor
        // features (inline / next-edit suggestions, chat titles, intent
        // detection). Inside an invoke_agent span (older VS Code, where Agent
        // mode ran in the extension) they're skipped: invoke_agent carries the
        // turn's totals. Current Agent mode is read from Copilot CLI session
        // logs instead (cliSessions.ts).
        if (span.name?.startsWith('chat ') || span.name === 'chat') {
          if (span.parentSpanId && agentSpanIds.has(span.parentSpanId)) continue;
          const inputTotal = pickNumber(attrs['gen_ai.usage.input_tokens']);
          const cacheRead = pickNumber(attrs['gen_ai.usage.cache_read.input_tokens']) ?? 0;
          const output = pickNumber(attrs['gen_ai.usage.output_tokens']);
          if (inputTotal === undefined && output === undefined) continue;
          events.push({
            eventId: `copilot-span:${span.spanId ?? crypto.randomUUID()}`,
            sessionId: sessionIdFrom(attrs),
            agent: 'copilot',
            ts: new Date().toISOString(),
            kind: 'turn_stop',
            status: spanStatus(span),
            channel: 'inline',
            model: pickString(attrs['gen_ai.response.model']) ?? modelFrom(attrs),
            // input_tokens includes cached tokens, as in the GenAI conventions.
            tokens: { input: Math.max((inputTotal ?? 0) - cacheRead, 0), output: output ?? 0, cacheRead },
            contextLimit: pickNumber(attrs['copilot_chat.request.max_prompt_tokens']),
            raw: { adapter: 'copilot', ref: `otlp:span:${span.spanId ?? 'unknown'}` },
          });
          continue;
        }

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
            textExcerpt: opts.captureContent ? assistantTextFrom(attrs) : undefined,
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
            // Copilot's tool arguments aren't captured, so terminal commands classify as plain shell.
            ...(span.name === 'execute_tool' ? { toolName: target, toolCategory: classifyTool(target) } : {}),
            model: modelFrom(attrs),
            raw: { adapter: 'copilot', ref: `otlp:span:${span.spanId ?? 'unknown'}` },
          });
        }
      }
    }
  }
  return events;
}
