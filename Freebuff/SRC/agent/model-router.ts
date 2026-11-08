import type { AppConfig } from '../utils/config';
import { log } from '../utils/logger';
import { planOffline } from './offline';

/**
 * Model router.
 *
 * The agent never talks to a vendor SDK directly — it asks this router for a
 * provider, and the router picks the best configured one. That keeps the loop
 * identical whether the brain is GPT, Claude, Groq, a local Ollama model, or
 * the built-in offline planner (so the app is usable with zero API keys).
 */

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
}

export interface TokenUsage {
  prompt: number;
  completion: number;
  total: number;
}

export interface StreamRequest {
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
  /** Tool names available this turn (used by the offline planner). */
  tools?: string[];
}

export interface StreamChunk {
  text?: string;
  usage?: TokenUsage;
  error?: string;
}

export type ProviderKind = 'openai-compatible' | 'anthropic' | 'offline';

export interface ProviderPreset {
  id: string;
  label: string;
  kind: ProviderKind;
  envKeys: string[];
  defaultBaseUrl: string;
  defaultModel: string;
  models: string[];
  local: boolean;
  installHint: string;
}

export const PROVIDERS: ProviderPreset[] = [
  {
    id: 'openai',
    label: 'OpenAI',
    kind: 'openai-compatible',
    envKeys: ['OPENAI_API_KEY'],
    defaultBaseUrl: 'https://api.openai.com/v1',
    defaultModel: 'gpt-4o-mini',
    models: ['gpt-4o-mini', 'gpt-4o', 'gpt-4.1-mini', 'o4-mini'],
    local: false,
    installHint: 'export OPENAI_API_KEY=sk-...',
  },
  {
    id: 'anthropic',
    label: 'Anthropic Claude',
    kind: 'anthropic',
    envKeys: ['ANTHROPIC_API_KEY'],
    defaultBaseUrl: 'https://api.anthropic.com/v1',
    defaultModel: 'claude-sonnet-4-5',
    models: ['claude-sonnet-4-5', 'claude-haiku-4-5', 'claude-3-5-haiku-latest'],
    local: false,
    installHint: 'export ANTHROPIC_API_KEY=sk-ant-...',
  },
  {
    id: 'groq',
    label: 'Groq',
    kind: 'openai-compatible',
    envKeys: ['GROQ_API_KEY'],
    defaultBaseUrl: 'https://api.groq.com/openai/v1',
    defaultModel: 'llama-3.3-70b-versatile',
    models: ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant', 'qwen-2.5-32b'],
    local: false,
    installHint: 'export GROQ_API_KEY=gsk_...',
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    kind: 'openai-compatible',
    envKeys: ['OPENROUTER_API_KEY'],
    defaultBaseUrl: 'https://openrouter.ai/api/v1',
    defaultModel: 'openai/gpt-4o-mini',
    models: ['openai/gpt-4o-mini', 'anthropic/claude-sonnet-4', 'google/gemini-2.0-flash-001'],
    local: false,
    installHint: 'export OPENROUTER_API_KEY=sk-or-...',
  },
  {
    id: 'ollama',
    label: 'Ollama (local)',
    kind: 'openai-compatible',
    envKeys: [],
    defaultBaseUrl: 'http://127.0.0.1:11434/v1',
    defaultModel: 'qwen2.5-coder:7b',
    models: ['qwen2.5-coder:7b', 'llama3.2:3b', 'gemma2:2b'],
    local: true,
    installHint: 'pkg install ollama && ollama serve   (or run Ollama on your PC and set AI_FREEBUFF_BASE_URL)',
  },
  {
    id: 'lmstudio',
    label: 'LM Studio (local)',
    kind: 'openai-compatible',
    envKeys: [],
    defaultBaseUrl: 'http://127.0.0.1:1234/v1',
    defaultModel: 'local-model',
    models: [],
    local: true,
    installHint: 'Start LM Studio server, then set AI_FREEBUFF_BASE_URL=http://<pc-ip>:1234/v1',
  },
  {
    id: 'custom',
    label: 'Custom endpoint',
    kind: 'openai-compatible',
    envKeys: ['AI_FREEBUFF_API_KEY'],
    defaultBaseUrl: '',
    defaultModel: 'default',
    models: [],
    local: false,
    installHint: 'export AI_FREEBUFF_BASE_URL=... AI_FREEBUFF_API_KEY=... AI_FREEBUFF_MODEL=...',
  },
  {
    id: 'offline',
    label: 'Offline planner',
    kind: 'offline',
    envKeys: [],
    defaultBaseUrl: '',
    defaultModel: 'heuristic-planner',
    models: [],
    local: true,
    installHint: 'No key needed — always available as a fallback.',
  },
];

export interface Provider {
  preset: ProviderPreset;
  model: string;
  baseUrl: string;
  stream(request: StreamRequest): AsyncGenerator<StreamChunk>;
  listModels?(): Promise<string[]>;
}

export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

function envKey(preset: ProviderPreset): string | undefined {
  for (const key of preset.envKeys) {
    const value = process.env[key];
    if (value && value.trim()) return value.trim();
  }
  return undefined;
}

function presetById(id: string): ProviderPreset | undefined {
  return PROVIDERS.find((preset) => preset.id === id);
}

/** True when the preset has everything it needs to be selected. */
export function isConfigured(preset: ProviderPreset): boolean {
  if (preset.kind === 'offline') return true;
  if (preset.id === 'custom') {
    return Boolean(process.env.AI_FREEBUFF_BASE_URL || process.env.AI_FREEBUFF_API_KEY);
  }
  if (preset.local) {
    // Local servers need no key; they are "configured" when an override exists
    // or when the default loopback endpoint is reachable (checked lazily).
    return true;
  }
  return Boolean(envKey(preset));
}

/* ------------------------------------------------------------------ */
/* SSE plumbing                                                        */
/* ------------------------------------------------------------------ */

async function* readSseData(response: Response): AsyncGenerator<string> {
  const body = response.body;
  if (!body) return;
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const data = trimmed.slice(5).trim();
        if (data === '[DONE]') return;
        if (data) yield data;
      }
    }
    const tail = buffer.trim();
    if (tail.startsWith('data:')) {
      const data = tail.slice(5).trim();
      if (data && data !== '[DONE]') yield data;
    }
  } finally {
    reader.releaseLock();
  }
}

function errorMessage(status: number, body: string): string {
  let detail = body.slice(0, 600);
  try {
    const parsed = JSON.parse(body) as { error?: { message?: string } | string; message?: string };
    if (typeof parsed.error === 'string') detail = parsed.error;
    else if (parsed.error?.message) detail = parsed.error.message;
    else if (parsed.message) detail = parsed.message;
  } catch {
    /* raw body is fine */
  }
  const hints: Record<number, string> = {
    401: 'check that your API key is exported in this shell',
    403: 'the key lacks access to this model',
    404: 'wrong base URL or model name',
    429: 'rate limit — wait a moment or switch model',
  };
  return `HTTP ${status}: ${detail}${hints[status] ? `\nHint: ${hints[status]}` : ''}`;
}

async function fetchWithRetry(url: string, init: RequestInit, signal?: AbortSignal, attempts = 2): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(url, { ...init, signal });
      if (response.status === 429 || response.status >= 500) {
        if (attempt < attempts) {
          await new Promise((resolve) => setTimeout(resolve, 600 * (attempt + 1)));
          continue;
        }
      }
      return response;
    } catch (error) {
      lastError = error;
      if (signal?.aborted) throw error;
      if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, 600 * (attempt + 1)));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

/* ------------------------------------------------------------------ */
/* Providers                                                           */
/* ------------------------------------------------------------------ */

class OpenAICompatibleProvider implements Provider {
  constructor(
    public preset: ProviderPreset,
    public model: string,
    public baseUrl: string,
    private apiKey: string | undefined,
  ) {}

  async *stream(request: StreamRequest): AsyncGenerator<StreamChunk> {
    const url = `${this.baseUrl.replace(/\/+$/, '')}/chat/completions`;
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'text/event-stream',
    };
    if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`;
    if (this.preset.id === 'openrouter') {
      headers['http-referer'] = 'https://github.com/morluto/rea';
      headers['x-title'] = 'AI-FREEBUFF MCP Termux';
    }

    const body: Record<string, unknown> = {
      model: this.model,
      messages: request.messages.map((message) => ({
        role: message.role === 'tool' ? 'user' : message.role,
        content: message.content,
      })),
      temperature: request.temperature ?? 0.4,
      max_tokens: request.maxTokens ?? 2048,
      stream: true,
    };

    let response: Response;
    try {
      response = await fetchWithRetry(url, { method: 'POST', headers, body: JSON.stringify(body) }, request.signal);
    } catch (error) {
      yield { error: `Cannot reach ${this.preset.label}: ${(error as Error).message}` };
      return;
    }

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      yield { error: errorMessage(response.status, text) };
      return;
    }

    let promptTokens = 0;
    let completionTokens = 0;
    try {
      for await (const data of readSseData(response)) {
        let parsed: any;
        try {
          parsed = JSON.parse(data);
        } catch {
          continue;
        }
        if (parsed.error) {
          yield { error: typeof parsed.error === 'string' ? parsed.error : parsed.error.message ?? 'provider error' };
          return;
        }
        const delta = parsed.choices?.[0]?.delta?.content;
        if (typeof delta === 'string' && delta.length > 0) yield { text: delta };
        const reasoning = parsed.choices?.[0]?.delta?.reasoning_content;
        if (!delta && typeof reasoning === 'string' && reasoning.length > 0) {
          // Local reasoning models stream their scratchpad first; keep the UI quiet.
          log.debug('reasoning chunk', { length: reasoning.length });
        }
        if (parsed.usage) {
          promptTokens = parsed.usage.prompt_tokens ?? promptTokens;
          completionTokens = parsed.usage.completion_tokens ?? completionTokens;
        }
      }
    } catch (error) {
      if (request.signal?.aborted) return;
      yield { error: `Stream interrupted: ${(error as Error).message}` };
      return;
    }

    if (!promptTokens) promptTokens = request.messages.reduce((total, message) => total + estimateTokens(message.content), 0);
    if (!completionTokens) completionTokens = 0;
    yield { usage: { prompt: promptTokens, completion: completionTokens, total: promptTokens + completionTokens } };
  }

  async listModels(): Promise<string[]> {
    const headers: Record<string, string> = {};
    if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`;
    try {
      const response = await fetch(`${this.baseUrl.replace(/\/+$/, '')}/models`, { headers });
      if (!response.ok) return this.preset.models;
      const data = (await response.json()) as { data?: Array<{ id?: string }> };
      return (data.data ?? []).map((entry) => entry.id || '').filter(Boolean).slice(0, 200);
    } catch {
      return this.preset.models;
    }
  }
}

class AnthropicProvider implements Provider {
  constructor(
    public preset: ProviderPreset,
    public model: string,
    public baseUrl: string,
    private apiKey: string | undefined,
  ) {}

  async *stream(request: StreamRequest): AsyncGenerator<StreamChunk> {
    if (!this.apiKey) {
      yield { error: 'ANTHROPIC_API_KEY is not set.' };
      return;
    }
    const system = request.messages
      .filter((message) => message.role === 'system')
      .map((message) => message.content)
      .join('\n\n');
    const messages = request.messages
      .filter((message) => message.role !== 'system')
      .map((message) => ({ role: message.role === 'assistant' ? 'assistant' : 'user', content: message.content }));

    const url = `${this.baseUrl.replace(/\/+$/, '')}/messages`;
    let response: Response;
    try {
      response = await fetchWithRetry(
        url,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-api-key': this.apiKey,
            'anthropic-version': '2023-06-01',
            accept: 'text/event-stream',
          },
          body: JSON.stringify({
            model: this.model,
            system: system || undefined,
            messages,
            max_tokens: request.maxTokens ?? 2048,
            temperature: request.temperature ?? 0.4,
            stream: true,
          }),
        },
        request.signal,
      );
    } catch (error) {
      yield { error: `Cannot reach Anthropic: ${(error as Error).message}` };
      return;
    }

    if (!response.ok) {
      yield { error: errorMessage(response.status, await response.text().catch(() => '')) };
      return;
    }

    let promptTokens = 0;
    let completionTokens = 0;
    try {
      for await (const data of readSseData(response)) {
        let parsed: any;
        try {
          parsed = JSON.parse(data);
        } catch {
          continue;
        }
        switch (parsed.type) {
          case 'content_block_delta':
            if (typeof parsed.delta?.text === 'string' && parsed.delta.text.length > 0) {
              yield { text: parsed.delta.text };
            }
            break;
          case 'message_start':
            promptTokens = parsed.message?.usage?.input_tokens ?? promptTokens;
            break;
          case 'message_delta':
            completionTokens = parsed.usage?.output_tokens ?? completionTokens;
            break;
          case 'error':
            yield { error: parsed.error?.message ?? 'Anthropic stream error' };
            return;
          default:
            break;
        }
      }
    } catch (error) {
      if (request.signal?.aborted) return;
      yield { error: `Stream interrupted: ${(error as Error).message}` };
      return;
    }

    yield {
      usage: {
        prompt: promptTokens || request.messages.reduce((total, message) => total + estimateTokens(message.content), 0),
        completion: completionTokens,
        total:
          (promptTokens || request.messages.reduce((total, message) => total + estimateTokens(message.content), 0)) +
          completionTokens,
      },
    };
  }

  async listModels(): Promise<string[]> {
    return this.preset.models;
  }
}

class OfflineProvider implements Provider {
  constructor(
    public preset: ProviderPreset,
    public model: string,
    public baseUrl = '',
  ) {}

  async *stream(request: StreamRequest): AsyncGenerator<StreamChunk> {
    const plan = planOffline(request.messages, request.tools ?? []);
    const text = plan.toolCall
      ? `${plan.text}\n\n\`\`\`tool\n${JSON.stringify(plan.toolCall, null, 2)}\n\`\`\``
      : plan.text;
    yield { text };
    const prompt = request.messages.reduce((total, message) => total + estimateTokens(message.content), 0);
    yield { usage: { prompt, completion: estimateTokens(text), total: prompt + estimateTokens(text) } };
  }
}

/* ------------------------------------------------------------------ */
/* Router                                                              */
/* ------------------------------------------------------------------ */

export interface ResolvedModel {
  provider: Provider;
  preset: ProviderPreset;
  model: string;
  baseUrl: string;
  reason: string;
}

export class ModelRouter {
  constructor(private config: AppConfig) {}

  /** Ordered provider preference for `auto` mode. */
  private autoOrder(): string[] {
    return ['openai', 'anthropic', 'groq', 'openrouter', 'custom', 'ollama', 'lmstudio', 'offline'];
  }

  private build(preset: ProviderPreset, model: string, baseUrl: string): Provider {
    const key = envKey(preset);
    if (preset.kind === 'offline') return new OfflineProvider(preset, model || preset.defaultModel);
    if (preset.kind === 'anthropic') return new AnthropicProvider(preset, model, baseUrl, key);
    return new OpenAICompatibleProvider(preset, model, baseUrl, key);
  }

  resolve(): ResolvedModel {
    const requested = this.config.model.provider || 'auto';
    const configuredBase = this.config.model.baseUrl || process.env.AI_FREEBUFF_BASE_URL || '';
    const configuredModel = this.config.model.model || process.env.AI_FREEBUFF_MODEL || '';

    if (requested !== 'auto') {
      const preset = presetById(requested) ?? presetById('custom')!;
      if (preset.id === 'custom') {
        const baseUrl = configuredBase || preset.defaultBaseUrl;
        const model = configuredModel || preset.defaultModel;
        return {
          provider: this.build(preset, model, baseUrl),
          preset,
          model,
          baseUrl,
          reason: baseUrl ? 'custom endpoint' : 'custom endpoint (base URL missing)',
        };
      }
      const baseUrl = configuredBase || preset.defaultBaseUrl;
      const model = configuredModel || preset.defaultModel;
      return { provider: this.build(preset, model, baseUrl), preset, model, baseUrl, reason: `pinned in config (${preset.id})` };
    }

    for (const id of this.autoOrder()) {
      const preset = presetById(id);
      if (!preset) continue;
      if (!isConfigured(preset)) continue;
      // Local endpoints are only auto-selected when explicitly pointed at.
      if (preset.local && preset.kind !== 'offline' && !configuredBase && !configuredModel) continue;
      const baseUrl = preset.id === 'custom' ? configuredBase : configuredBase || preset.defaultBaseUrl;
      const model = configuredModel || preset.defaultModel;
      const reason =
        preset.kind === 'offline'
          ? 'no API key found — using the built-in planner (set OPENAI_API_KEY or run Ollama to unlock full reasoning)'
          : `${preset.label} key detected`;
      return { provider: this.build(preset, model, baseUrl), preset, model, baseUrl, reason };
    }

    const offline = presetById('offline')!;
    return {
      provider: this.build(offline, offline.defaultModel, ''),
      preset: offline,
      model: offline.defaultModel,
      baseUrl: '',
      reason: 'fallback',
    };
  }

  /** Probe every provider without spending tokens. */
  async status(): Promise<Array<{ preset: ProviderPreset; configured: boolean; reachable: boolean; detail: string }>> {
    const rows: Array<{ preset: ProviderPreset; configured: boolean; reachable: boolean; detail: string }> = [];
    for (const preset of PROVIDERS) {
      if (preset.kind === 'offline') {
        rows.push({ preset, configured: true, reachable: true, detail: 'always available' });
        continue;
      }
      const configured = isConfigured(preset);
      if (!configured) {
        rows.push({ preset, configured, reachable: false, detail: `not configured · ${preset.installHint}` });
        continue;
      }
      const baseUrl = preset.id === 'custom' ? process.env.AI_FREEBUFF_BASE_URL || '' : preset.defaultBaseUrl;
      if (preset.local && !baseUrl) {
        rows.push({ preset, configured, reachable: false, detail: 'no base URL' });
        continue;
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 2500);
      try {
        const response = await fetch(`${baseUrl.replace(/\/+$/, '')}/models`, {
          headers: envKey(preset) ? { authorization: `Bearer ${envKey(preset)}` } : {},
          signal: controller.signal,
        });
        rows.push({
          preset,
          configured,
          reachable: response.ok,
          detail: response.ok ? 'endpoint reachable' : `HTTP ${response.status}`,
        });
      } catch (error) {
        rows.push({
          preset,
          configured,
          reachable: false,
          detail: controller.signal.aborted ? 'timeout' : (error as Error).message,
        });
      } finally {
        clearTimeout(timer);
      }
    }
    return rows;
  }
}

/** Convenience: collect a whole completion into a string. */
export async function collectCompletion(provider: Provider, request: StreamRequest): Promise<{ text: string; usage?: TokenUsage; error?: string }> {
  let text = '';
  let usage: TokenUsage | undefined;
  let error: string | undefined;
  for await (const chunk of provider.stream(request)) {
    if (chunk.error) error = chunk.error;
    if (chunk.text) text += chunk.text;
    if (chunk.usage) usage = chunk.usage;
  }
  return { text, usage, error };
}
