import * as http from 'http';
import { advisorId } from '../advisor/newAdvisor';

/**
 * A mock local model for the advisor UI's setup chat (the + page; snagboat-79f.7.16), so the whole
 * flow can be tried in a browser without a real model: pick a model, talk, switch models, revise,
 * accept, discard. It speaks the OpenAI-compatible API Ollama does (streamed or not), on this machine
 * only. Dev tooling only; never shipped. It proves the page and the core's checks, not the quality of
 * a model's goal setting.
 *
 *   npm run mock:model [-- --port 11435]
 *
 * Then add it to snagboat.advisors in your user settings (it prints the entry) and reload the window, or
 * add it to "advisors" in ~/.snagboat/config.json's defaults. Run two entries on the same address with
 * different "model" names to try a model switch: each answer names the model that gave it.
 *
 * The script, by turn:
 * - your first message: it asks one clarifying question, naming what you said;
 * - your next message (or a first one with "propose" in it): it proposes an advisor, choosing measures
 *   and rules from the lists Snagboat sent by the words you used (cost, context, stall, risk, noise);
 * - a revise note: a revised proposal, its status line from your note, and the period if you name one;
 * - Snagboat's repair note (a proposal it kept out): a corrected proposal.
 * Words in your message that force the other paths:
 * - mock:bad   a proposal with a name already taken and an invented measure, which Snagboat keeps out
 *              and sends straight back for repair;
 * - mock:text  prose instead of the JSON asked for;
 * - mock:slow  the answer waits 8 seconds;
 * - mock:error the request fails (HTTP 500).
 */

export interface MockMessage {
  role: string;
  content: string;
}

export interface MockAnswer {
  /** The model's text, or undefined when the request fails. */
  content?: string;
  status: number;
  delayMs: number;
}

interface Catalog {
  measures: Array<{ id: string; label?: string }>;
  rules: Array<{ id: string; title?: string }>;
  periods?: string[];
  taken: string[];
}

const TOPICS: Array<{ words: RegExp; name: string; goal: string; status: string; measures: RegExp; rules: RegExp; icon: string; color: string }> = [
  { words: /cost|token|spend|cheap|money|budget|cache/i, name: 'Ledger', goal: 'token-cost-down', status: 'Keeping token cost down', measures: /token|cache/, rules: /cache|runaway|token|cost/, icon: 'coin', color: 'amber' },
  { words: /context|compact|window|forget/i, name: 'Headroom', goal: 'context-headroom', status: 'Know before a session compacts', measures: /cache|context/, rules: /context/, icon: 'telescope', color: 'blue' },
  { words: /stall|stuck|slow|wait|idle|green|test/i, name: 'Tempo', goal: 'unstuck-sooner', status: 'Get unstuck sooner', measures: /stall|green|minutes/, rules: /stall|loop|retry/, icon: 'compass', color: 'teal' },
  { words: /risk|danger|safe|destroy|delete|force|secur/i, name: 'Bulwark', goal: 'fewer-risky-commands', status: 'Fewer risky commands', measures: /risk|approval/, rules: /risk|destruct|danger|secret/, icon: 'anchor', color: 'red' },
  { words: /noise|notif|nag|interrupt|useful|dismiss/i, name: 'Hush', goal: 'useful-notifications', status: 'Only the notifications worth it', measures: /notif|dismiss|useful/, rules: /^$/, icon: 'compass', color: 'blue' },
];

const REPAIR = /^\(From Snagboat, not the person\.\)/;
const REVISE = /^A note on your last proposal; answer it with a revised proposal: /;

function catalogOf(messages: MockMessage[]): Catalog {
  const system = messages.find((m) => m.role === 'system')?.content ?? '';
  const at = system.indexOf('What you may choose from:\n');
  try {
    const c = JSON.parse(system.slice(at + 'What you may choose from:\n'.length)) as Partial<Catalog>;
    return { measures: c.measures ?? [], rules: c.rules ?? [], periods: c.periods, taken: c.taken ?? [] };
  } catch {
    return { measures: [], rules: [], taken: [] };
  }
}

/** A name whose advisor id isn't taken: the topic's, then numbered. */
function freeName(base: string, taken: string[]): string {
  const used = new Set(taken);
  for (let n = 1; ; n++) {
    const name = n === 1 ? base : `${base} ${n}`;
    if (!used.has(advisorId(name))) return name;
  }
}

function proposalFor(said: string, catalog: Catalog, model: string, extra: { status?: string; period?: string } = {}) {
  const topic = TOPICS.find((t) => t.words.test(said)) ?? TOPICS[0];
  let measures = catalog.measures.filter((m) => topic.measures.test(m.id)).map((m) => m.id).slice(0, 3);
  if (!measures.length) measures = catalog.measures.slice(0, 2).map((m) => m.id);
  const rules = catalog.rules.filter((r) => topic.rules.test(r.id)).map((r) => r.id).slice(0, 3);
  return {
    name: freeName(topic.name, catalog.taken),
    status: extra.status ?? topic.status,
    goal: topic.goal,
    measures,
    rules,
    maxPerHour: 2,
    period: extra.period ?? 'weekly',
    color: topic.color,
    icon: topic.icon,
    voice: `You are a mock advisor (${model}) that watches ${topic.status.toLowerCase()}. Speak plainly, in one or two sentences.`,
  };
}

/** The mock's answer to one chat request. */
export function mockAnswer(model: string, messages: MockMessage[]): MockAnswer {
  const catalog = catalogOf(messages);
  const users = messages.filter((m) => m.role === 'user');
  const last = users[users.length - 1]?.content ?? '';
  // What you said, without Snagboat's own notes.
  const yours = users.map((m) => m.content).filter((c) => !REPAIR.test(c)).map((c) => c.replace(REVISE, ''));
  const said = yours.join(' ');
  const delayMs = /mock:slow/.test(last) ? 8000 : 0;
  const json = (reply: string, proposal: unknown): MockAnswer => ({ content: JSON.stringify({ reply, proposal }), status: 200, delayMs });

  if (/mock:error/.test(last)) return { status: 500, delayMs };
  if (/mock:text/.test(last)) return { content: `Here's my thinking, as prose rather than JSON (${model}): an advisor for "${last.slice(0, 60)}".`, status: 200, delayMs };
  if (REPAIR.test(last)) return json(`Fixed (${model}): picked only from your lists, with a name not taken.`, proposalFor(said, catalog, model));
  if (REVISE.test(last)) {
    const note = last.replace(REVISE, '').trim();
    const period = (catalog.periods ?? ['daily', 'weekly', 'monthly']).find((p) => new RegExp(`\\b${p}\\b`, 'i').test(note));
    const status = note.length > 60 ? `${note.slice(0, 57)}…` : note;
    return json(`Revised (${model}) from your note.`, proposalFor(said, catalog, model, { status: status || undefined, period }));
  }
  if (/mock:bad/.test(last)) {
    const proposal = proposalFor(said, catalog, model);
    return json(`I propose an advisor (${model}), though it reuses a name and invents a measure.`, {
      ...proposal,
      name: catalog.taken[0] ?? proposal.name,
      measures: ['made_up_measure'],
    });
  }
  const askedBefore = messages.some((m) => m.role === 'assistant');
  if (!askedBefore && !/propose/i.test(last)) {
    return json(`You said: "${last.slice(0, 80)}". What would tell you it's going better, a week from now? (${model})`, null);
  }
  return json(`Here's an advisor for that (${model}).`, proposalFor(said, catalog, model));
}

/** Serves the mock on 127.0.0.1. */
export function startMockModel(port: number, log: (line: string) => void = () => undefined): Promise<http.Server> {
  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url?.endsWith('/models')) {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ object: 'list', data: [{ id: 'mock', object: 'model' }] }));
      return;
    }
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      let request: { model?: string; messages?: MockMessage[]; stream?: boolean };
      try {
        request = JSON.parse(body);
      } catch {
        res.statusCode = 400;
        res.end('{"error":"not JSON"}');
        return;
      }
      const model = request.model ?? 'mock';
      const answer = mockAnswer(model, request.messages ?? []);
      log(`${model}: ${answer.status}${answer.delayMs ? ` after ${answer.delayMs} ms` : ''} ${answer.content?.slice(0, 100) ?? ''}`);
      setTimeout(() => {
        if (answer.content === undefined) {
          res.statusCode = answer.status;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: { message: 'mock:error asked for a failure' } }));
          return;
        }
        const usage = { prompt_tokens: 100, completion_tokens: 20 };
        if (request.stream) {
          res.setHeader('Content-Type', 'text/event-stream');
          res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: answer.content } }] })}\n\n`);
          res.write(`data: ${JSON.stringify({ choices: [], usage })}\n\n`);
          res.end('data: [DONE]\n\n');
        } else {
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: answer.content } }], usage }));
        }
      }, answer.delayMs);
    });
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}

async function main(): Promise<void> {
  const i = process.argv.indexOf('--port');
  const port = i >= 0 ? Number(process.argv[i + 1]) : 11435;
  const server = await startMockModel(port, (line) => console.log(line));
  const address = server.address() as { port: number };
  const base = `http://127.0.0.1:${address.port}/v1`;
  console.log(`Mock model listening on ${base}`);
  console.log('Add to snagboat.advisors in your user settings (two entries, to try a model switch), then reload:');
  console.log(
    JSON.stringify(
      [
        { id: 'mock-a', label: 'Mock A', baseUrl: base, model: 'mock-a' },
        { id: 'mock-b', label: 'Mock B', baseUrl: base, model: 'mock-b' },
      ],
      null,
      2
    )
  );
  console.log('Words that force other paths: mock:bad, mock:text, mock:slow, mock:error. Ctrl+C stops it.');
}

if (require.main === module) void main();
