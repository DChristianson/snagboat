import * as fs from 'fs';
import * as path from 'path';

/**
 * Structure-only capture of Copilot's OTLP traffic, for learning which spans
 * carry what (docs/design/conversation-view.md, Copilot). Keeps span names,
 * ids, parent links, timings, status codes, attribute *names*, and numeric or
 * boolean attribute values (token counts, durations). Every string value is
 * replaced by its length, so prompts, replies, tool arguments, file paths,
 * and model names never reach the capture.
 */

type AttrValue = { stringValue?: string; intValue?: string | number; doubleValue?: number; boolValue?: boolean; arrayValue?: unknown; kvlistValue?: unknown };

function redactValue(v: AttrValue | undefined): unknown {
  if (!v) return null;
  if (v.stringValue !== undefined) return `<string len=${v.stringValue.length}>`;
  if (v.intValue !== undefined) return Number(v.intValue);
  if (v.doubleValue !== undefined) return v.doubleValue;
  if (v.boolValue !== undefined) return v.boolValue;
  if (v.arrayValue !== undefined) return '<array>';
  if (v.kvlistValue !== undefined) return '<kvlist>';
  return '<other>';
}

function redactAttributes(attrs: Array<{ key: string; value?: AttrValue }> | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const a of attrs ?? []) if (typeof a?.key === 'string') out[a.key] = redactValue(a.value);
  return out;
}

/** The structure of one OTLP/JSON traces or metrics payload, with string values removed. */
export function payloadStructure(url: string, payload: any): unknown {
  if (url.includes('/v1/traces')) {
    return {
      signal: 'traces',
      resources: (payload?.resourceSpans ?? []).map((rs: any) => ({
        resource: redactAttributes(rs?.resource?.attributes),
        spans: (rs?.scopeSpans ?? []).flatMap((ss: any) =>
          (ss?.spans ?? []).map((span: any) => ({
            name: typeof span?.name === 'string' ? span.name : '<unnamed>',
            traceId: span?.traceId,
            spanId: span?.spanId,
            parentSpanId: span?.parentSpanId || undefined,
            kind: span?.kind,
            startTimeUnixNano: span?.startTimeUnixNano,
            endTimeUnixNano: span?.endTimeUnixNano,
            status: span?.status?.code,
            attributes: redactAttributes(span?.attributes),
            events: (span?.events ?? []).map((e: any) => ({ name: e?.name, attributes: redactAttributes(e?.attributes) })),
          }))
        ),
      })),
    };
  }
  if (url.includes('/v1/metrics')) {
    return {
      signal: 'metrics',
      resources: (payload?.resourceMetrics ?? []).map((rm: any) => ({
        resource: redactAttributes(rm?.resource?.attributes),
        metrics: (rm?.scopeMetrics ?? []).flatMap((sm: any) =>
          (sm?.metrics ?? []).map((m: any) => ({
            name: m?.name,
            type: ['sum', 'gauge', 'histogram'].find((t) => m?.[t] !== undefined),
            dataPoints: (m?.sum ?? m?.gauge ?? m?.histogram)?.dataPoints?.map((dp: any) => ({ attributes: redactAttributes(dp?.attributes) })) ?? [],
          }))
        ),
      })),
    };
  }
  if (url.includes('/v1/logs')) {
    return {
      signal: 'logs',
      resources: (payload?.resourceLogs ?? []).map((rl: any) => ({
        resource: redactAttributes(rl?.resource?.attributes),
        records: (rl?.scopeLogs ?? []).flatMap((sl: any) =>
          (sl?.logRecords ?? []).map((r: any) => ({
            eventName: typeof r?.eventName === 'string' ? r.eventName : undefined,
            severityText: typeof r?.severityText === 'string' ? r.severityText : undefined,
            traceId: r?.traceId,
            spanId: r?.spanId,
            timeUnixNano: r?.timeUnixNano ?? r?.observedTimeUnixNano,
            body: redactValue(r?.body),
            attributes: redactAttributes(r?.attributes),
          }))
        ),
      })),
    };
  }
  return { signal: 'other', url };
}

/** Appends one structure record per payload to <dir>/<UTC date>.jsonl. */
export class StructureCapture {
  constructor(private readonly dir: string) {}

  record(url: string, payload: unknown): void {
    const line = JSON.stringify({ receivedAt: new Date().toISOString(), structure: payloadStructure(url, payload) }) + '\n';
    const file = path.join(this.dir, `${new Date().toISOString().slice(0, 10)}.jsonl`);
    fs.promises
      .mkdir(this.dir, { recursive: true })
      .then(() => fs.promises.appendFile(file, line, 'utf8'))
      .catch((err) => console.error('snagboat: failed to write Copilot structure capture', err));
  }
}
