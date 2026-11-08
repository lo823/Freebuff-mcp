/**
 * Tool-call protocol parser.
 *
 * The agent asks models to emit tool calls as fenced JSON blocks:
 *
 *   ```tool
 *   { "name": "file_read", "args": { "path": "README.md" } }
 *   ```
 *
 * This works with every chat-completions endpoint (OpenAI, Groq, OpenRouter,
 * Ollama, Anthropic, or the offline planner) with no vendor-specific function
 * calling API, which is what keeps the app portable across providers.
 */

export interface ParsedToolCall {
  name: string;
  args: Record<string, unknown>;
}

const FENCED_PATTERN = /```(?:tool|tool_call|json:tool|tools)\s*\r?\n([\s\S]*?)```/gi;
const TAGGED_PATTERN = /<tool_call>\s*([\s\S]*?)<\/tool_call>/gi;

function normalizeArgs(value: unknown): Record<string, unknown> {
  if (value === undefined || value === null) return {};
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value) as unknown;
      return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }
  return typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function normalizeCall(raw: unknown): ParsedToolCall | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const record = raw as Record<string, any>;
  const name = record.name ?? record.tool ?? record.tool_name ?? record.function?.name;
  if (typeof name !== 'string' || !name.trim()) return null;
  const args = record.args ?? record.arguments ?? record.input ?? record.parameters ?? record.function?.arguments ?? {};
  return { name: name.trim(), args: normalizeArgs(args) };
}

/** Extract every tool call from an assistant message. */
export function parseToolCalls(text: string): ParsedToolCall[] {
  const calls: ParsedToolCall[] = [];

  for (const pattern of [FENCED_PATTERN, TAGGED_PATTERN]) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      const payload = (match[1] ?? '').trim();
      if (!payload) continue;
      try {
        const parsed = JSON.parse(payload) as unknown;
        const list = Array.isArray(parsed) ? parsed : [parsed];
        for (const entry of list) {
          const call = normalizeCall(entry);
          if (call) calls.push(call);
        }
      } catch {
        // A model may emit multiple JSON objects without an array wrapper.
        const objects = payload.match(/\{[\s\S]*?\}(?=\s*\{|\s*$)/g) ?? [];
        for (const object of objects) {
          try {
            const call = normalizeCall(JSON.parse(object));
            if (call) calls.push(call);
          } catch {
            /* ignore malformed fragment */
          }
        }
      }
    }
  }

  return calls;
}

/** Remove tool blocks before showing text to the user. */
export function stripToolBlocks(text: string): string {
  return text
    .replace(/```(?:tool|tool_call|json:tool|tools)\s*\r?\n[\s\S]*?```/gi, '')
    .replace(/<tool_call>[\s\S]*?<\/tool_call>/gi, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Heuristic used by the UI/agent to detect a truncated tool block. */
export function looksLikeTruncatedToolCall(text: string): boolean {
  return /```(?:tool|tool_call)\s*$/i.test(text.trim()) || (/<tool_call>/i.test(text) && !/<\/tool_call>/i.test(text));
}
