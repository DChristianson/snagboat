import * as crypto from 'crypto';
import { DigestPolicy, HOSTED_POLICY, LOCAL_POLICY } from './digest';

/**
 * Advisor providers: OpenAI-compatible chat completion endpoints. A provider
 * is local only if its URL is on this machine; anything else is hosted, needs
 * your API key, and is audited. Requests carry a system prompt and one digest,
 * never tools, so a model can only answer with text. See
 * docs/design/trusted-advisor.md#providers.
 */

export interface ProviderConfig {
  id: string;
  label: string;
  /** e.g. http://localhost:11434/v1 (Ollama) or https://api.openai.com/v1. */
  baseUrl: string;
  model: string;
  kind: 'local' | 'hosted';
  /** What it may receive. */
  policy: DigestPolicy;
}

export const DEFAULT_PROVIDERS = [{ id: 'local', label: 'Local (Ollama)', baseUrl: 'http://localhost:11434/v1', model: '' }];

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/** Whether a URL stays on this machine. */
export function isLocalUrl(url: string): boolean {
  try {
    return LOOPBACK.has(new URL(url).hostname);
  } catch {
    return false;
  }
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Providers from settings, with each kind's sending defaults; problems name the entry. */
export function parseProviders(value: unknown): { providers: ProviderConfig[]; problems: string[] } {
  const list = Array.isArray(value) ? value : DEFAULT_PROVIDERS;
  const providers: ProviderConfig[] = [];
  const problems: string[] = [];
  for (const [i, entry] of list.entries()) {
    const where = isObject(entry) && typeof entry.id === 'string' ? `provider ${entry.id}` : `provider ${i + 1}`;
    if (!isObject(entry) || typeof entry.id !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(entry.id)) {
      problems.push(`${where}: id must be lowercase letters, digits, and dashes`);
      continue;
    }
    let url: URL | undefined;
    try {
      url = typeof entry.baseUrl === 'string' ? new URL(entry.baseUrl) : undefined;
    } catch {
      // reported below
    }
    if (!url || (url.protocol !== 'http:' && url.protocol !== 'https:')) {
      problems.push(`${where}: baseUrl must be an http or https URL`);
      continue;
    }
    const local = isLocalUrl(url.href);
    if (!local && url.protocol !== 'https:') {
      problems.push(`${where}: a provider off this machine must use https`);
      continue;
    }
    if (providers.some((p) => p.id === entry.id)) {
      problems.push(`${where}: another provider has this id`);
      continue;
    }
    const base = local ? LOCAL_POLICY : HOSTED_POLICY;
    const send = isObject(entry.send) ? entry.send : {};
    const flag = (k: 'prompts' | 'replies' | 'sessionNames') => (typeof send[k] === 'boolean' ? (send[k] as boolean) : base[k]);
    providers.push({
      id: entry.id,
      label: typeof entry.label === 'string' && entry.label.trim() ? entry.label.trim() : entry.id,
      baseUrl: url.href.replace(/\/+$/, ''),
      model: typeof entry.model === 'string' ? entry.model.trim() : '',
      kind: local ? 'local' : 'hosted',
      policy: { prompts: flag('prompts'), replies: flag('replies'), sessionNames: flag('sessionNames'), paths: send.paths === 'hashed' ? 'hashed' : base.paths },
    });
  }
  return { providers, problems };
}

/**
 * What an approval covers: where requests go and what they may contain.
 * Changing either asks again; changing the model doesn't.
 */
export function approvalKey(p: ProviderConfig): string {
  return crypto.createHash('sha256').update(JSON.stringify({ id: p.id, baseUrl: p.baseUrl, policy: p.policy })).digest('hex').slice(0, 16);
}

export interface ChatMessage {
  role: 'system' | 'user';
  content: string;
}

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<{
  ok: boolean;
  status: number;
  headers?: { get(name: string): string | null };
  body?: ReadableStream<Uint8Array> | null;
  json(): Promise<unknown>;
  text(): Promise<string>;
}>;

// Local models can think for minutes and cost nothing but time; hosted ones answer faster or not at all.
const LOCAL_TIMEOUT_MS = 600_000;
const HOSTED_TIMEOUT_MS = 180_000;

function headers(apiKey?: string): Record<string, string> {
  return { 'Content-Type': 'application/json', ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) };
}

async function failure(res: Awaited<ReturnType<FetchLike>>): Promise<Error> {
  const body = (await res.text().catch(() => '')).slice(0, 300);
  return new Error(`HTTP ${res.status}${body ? `: ${body}` : ''}`);
}

/** The request body sent for a completion; exported so the preview and the audit hash match what's sent. */
/**
 * Streamed, so the server's headers arrive at once: Node's fetch gives up on a
 * response whose headers take more than 5 minutes, which a local model that
 * thinks first easily does.
 */
export function completionBody(model: string, messages: ChatMessage[], json = false): string {
  return JSON.stringify({ model, messages, temperature: 0.2, stream: true, stream_options: { include_usage: true }, ...(json ? { response_format: { type: 'json_object' } } : {}) });
}

type Usage = { prompt_tokens?: unknown; completion_tokens?: unknown };

/** Reads a streamed completion (server-sent events): the text deltas joined, and the usage if the server sends it. */
async function readStream(body: ReadableStream<Uint8Array>): Promise<{ content: string; usage?: Usage }> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let content = '';
  let usage: Usage | undefined;
  const take = (line: string): boolean => {
    if (!line.startsWith('data:')) return false;
    const data = line.slice(5).trim();
    if (data === '[DONE]') return true;
    const chunk = JSON.parse(data) as { choices?: Array<{ delta?: { content?: unknown } }>; usage?: Usage; error?: { message?: unknown } };
    if (chunk.error) throw new Error(String(chunk.error.message ?? 'the stream reported an error'));
    const delta = chunk.choices?.[0]?.delta?.content;
    if (typeof delta === 'string') content += delta;
    if (chunk.usage) usage = chunk.usage;
    return false;
  };
  for (;;) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    const lines = buffer.split('\n');
    buffer = done ? '' : lines.pop()!;
    for (const line of lines) if (take(line.trim())) return { content, usage };
    if (done) return { content, usage };
  }
}

export interface Completion {
  text: string;
  /** Prompt tokens the server says it read: far fewer than sent means it cut the prompt to fit its context window. */
  promptTokens?: number;
  completionTokens?: number;
}

/** One chat completion. No tools are ever offered. A reasoning model's <think> block is dropped. */
export async function complete(p: ProviderConfig, messages: ChatMessage[], apiKey: string | undefined, fetchImpl: FetchLike, jsonMode = false): Promise<Completion> {
  const res = await fetchImpl(`${p.baseUrl}/chat/completions`, { method: 'POST', headers: headers(apiKey), body: completionBody(p.model, messages, jsonMode), signal: AbortSignal.timeout(p.kind === 'local' ? LOCAL_TIMEOUT_MS : HOSTED_TIMEOUT_MS) });
  if (!res.ok) throw await failure(res);
  let content: unknown;
  let usage: Usage | undefined;
  if (res.body && (res.headers?.get('content-type') ?? '').includes('text/event-stream')) {
    ({ content, usage } = await readStream(res.body));
  } else {
    // A server that ignored "stream" answers in one piece.
    const json = (await res.json()) as { choices?: Array<{ message?: { content?: unknown } }>; usage?: Usage };
    content = json.choices?.[0]?.message?.content;
    usage = json.usage;
  }
  const text = typeof content === 'string' ? content.replace(/<think>[\s\S]*?<\/think>/g, '').trim() : '';
  if (!text) throw new Error('the response had no text');
  const n = (v: unknown) => (typeof v === 'number' ? v : undefined);
  return { text, promptTokens: n(usage?.prompt_tokens), completionTokens: n(usage?.completion_tokens) };
}

/**
 * Whether the server read far fewer prompt tokens than were sent: it cut the
 * prompt to fit its context window (Ollama does this silently). JSON runs
 * about 3.5 characters a token.
 */
export function promptWasCut(completion: Completion, messages: ChatMessage[]): boolean {
  const sent = messages.reduce((n, m) => n + m.content.length, 0) / 3.5;
  return completion.promptTokens !== undefined && completion.promptTokens < sent * 0.6;
}

/** The models a provider offers (GET /models), for picking one. */
export async function listModels(p: ProviderConfig, apiKey: string | undefined, fetchImpl: FetchLike): Promise<string[]> {
  const res = await fetchImpl(`${p.baseUrl}/models`, { method: 'GET', headers: headers(apiKey), signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw await failure(res);
  const json = (await res.json()) as { data?: Array<{ id?: unknown }> };
  return (json.data ?? []).map((m) => m.id).filter((id): id is string => typeof id === 'string').sort();
}
