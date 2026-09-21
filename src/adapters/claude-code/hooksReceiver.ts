import * as http from 'http';
import { AdapterContext } from '../../core/types';
import { normalizeHookPayload } from './normalize';

export class HooksReceiver {
  private server?: http.Server;

  constructor(
    private readonly ctx: AdapterContext,
    private readonly port: number
  ) {}

  start(): void {
    this.server = http.createServer((req, res) => {
      if (req.method !== 'POST') {
        res.writeHead(404).end();
        return;
      }
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        res.writeHead(200).end();
        const raw = Buffer.concat(chunks).toString('utf8');
        let payload: unknown;
        try {
          payload = JSON.parse(raw);
        } catch (err) {
          console.warn('snagboat: failed to parse hook payload as JSON', err);
          return;
        }
        const event = normalizeHookPayload(payload);
        if (event) {
          this.ctx.publish(event);
        } else {
          console.warn('snagboat: hook payload parsed but did not map to a NormalizedEvent', payload);
        }
      });
    });
    this.server.on('error', (err) => {
      this.ctx.reportHealth('hooksReceiver', `failed to listen on port ${this.port}: ${err.message}`);
    });
    this.server.listen(this.port, '127.0.0.1', () => {
      this.ctx.reportHealth('hooksReceiver', undefined);
    });
  }

  stop(): void {
    this.server?.close();
    this.server = undefined;
  }
}
