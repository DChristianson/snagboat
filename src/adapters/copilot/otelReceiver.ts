import * as http from 'http';
import * as zlib from 'zlib';
import { AdapterContext } from '../../core/types';
import { normalizeOtlpTraces, normalizeOtlpMetrics } from './normalize';

export class OtelReceiver {
  private server?: http.Server;

  constructor(
    private readonly ctx: AdapterContext,
    private readonly port: number
  ) {}

  start(): void {
    this.server = http.createServer((req, res) => this.handleRequest(req, res));
    this.server.on('error', (err) => {
      this.ctx.reportHealth('otelReceiver', `failed to listen on port ${this.port}: ${err.message}`);
    });
    this.server.listen(this.port, '127.0.0.1', () => {
      this.ctx.reportHealth('otelReceiver', undefined);
    });
  }

  stop(): void {
    this.server?.close();
    this.server = undefined;
  }

  private handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    if (req.method !== 'POST') {
      res.writeHead(404).end();
      return;
    }
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      // OTLP/HTTP exporters expect a valid (if empty) response body for the
      // relevant signal; an empty JSON object is accepted by every exporter
      // implementation we're aware of.
      res.writeHead(200, { 'Content-Type': 'application/json' }).end('{}');
      this.processBody(req.url ?? '', Buffer.concat(chunks), req.headers['content-encoding']);
    });
  }

  private processBody(url: string, raw: Buffer, contentEncoding: string | string[] | undefined): void {
    let body: Buffer;
    try {
      body = contentEncoding === 'gzip' ? zlib.gunzipSync(raw) : raw;
    } catch (err) {
      console.warn('snagboat: failed to decompress OTLP payload', err);
      return;
    }

    let json: unknown;
    try {
      json = JSON.parse(body.toString('utf8'));
    } catch {
      // With Copilot's captureContent on, payloads carry prompts and replies, and
      // JSON.parse errors quote part of their input, so log only the size.
      console.warn(`snagboat: failed to parse OTLP payload as JSON (${body.length} bytes)`);
      return;
    }

    const events = url.includes('/v1/metrics')
      ? normalizeOtlpMetrics(json)
      : url.includes('/v1/traces')
        ? normalizeOtlpTraces(json, { captureContent: this.ctx.captureContent() })
        : [];

    if (events.length === 0) {
      console.log(`snagboat: OTel receiver got a request on ${url} that produced no events (${body.length} bytes)`);
    }
    for (const event of events) {
      this.ctx.publish(event);
    }
  }
}
