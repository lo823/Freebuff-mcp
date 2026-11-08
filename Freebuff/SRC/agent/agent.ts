import type { McpRegistry } from '../mcp/registry';
import type { DangerLevel } from '../mcp/types';
import { buildSkillContext } from '../skills/loader';
import { capOutput, oneLine } from '../utils/text';
import { recordUsage } from '../utils/usage';
import type { ChatMessage, ModelRouter, TokenUsage } from './model-router';
import { parseToolCalls, stripToolBlocks } from './parser';
import { buildSystemPrompt } from './prompt';
import type { Toolkit } from './tools';

/**
 * The agent loop.
 *
 *   user input → model → (tool calls → results)* → final answer
 *
 * Implemented as an async generator so the Ink UI can render every delta,
 * tool invocation and result as it happens, and so a single AbortController can
 * cancel a run mid-stream.
 */

export interface ApprovalRequest {
  tool: string;
  danger: DangerLevel;
  args: Record<string, unknown>;
  summary: string;
}

export type ApprovalGate = (request: ApprovalRequest) => Promise<boolean>;

export interface AgentRuntime {
  toolkit: Toolkit;
  router: ModelRouter;
  registry: McpRegistry;
  getConfig: () => import('../utils/config').AppConfig;
  workspace: string;
  home: string;
  sessionId: string;
  approve: ApprovalGate;
  log: (message: string) => void;
  maxSteps?: number;
}

export type AgentEvent =
  | { type: 'status'; message: string }
  | { type: 'delta'; text: string }
  | { type: 'assistant'; text: string }
  | { type: 'tool_call'; id: string; name: string; args: Record<string, unknown> }
  | { type: 'approval_required'; id: string; name: string; danger: DangerLevel; args: Record<string, unknown> }
  | { type: 'tool_result'; id: string; name: string; ok: boolean; output: string; durationMs: number }
  | { type: 'usage'; usage: TokenUsage }
  | { type: 'error'; message: string }
  | { type: 'done'; steps: number };

function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return { prompt: a.prompt + b.prompt, completion: a.completion + b.completion, total: a.total + b.total };
}

function resultBlock(name: string, ok: boolean, output: string): string {
  return `<tool_result name="${name}" ok="${ok}">\n${output}\n</tool_result>`;
}

function summarizeArgs(name: string, args: Record<string, unknown>): string {
  const target = (args.path ?? args.file ?? args.url ?? args.repo ?? args.name ?? args.command ?? '') as string;
  const preview = typeof target === 'string' && target ? ` ${oneLine(target, 60)}` : '';
  return `${name}${preview}`;
}

export async function* runAgent(
  runtime: AgentRuntime,
  history: ChatMessage[],
  input: string,
  signal: AbortSignal,
): AsyncGenerator<AgentEvent> {
  const config = runtime.getConfig();
  const resolved = runtime.router.resolve();
  const tools = runtime.toolkit.catalog();
  const mcpSummary =
    runtime.registry
      .enabled()
      .map((module) => `${module.id}:${module.tools.length}`)
      .join(' ') || 'none';

  const skillsContext = config.skills.autoActivate === false ? '' : await buildSkillContext(config.skills.active);

  const messages: ChatMessage[] = [
    {
      role: 'system',
      content: buildSystemPrompt({
        workspace: runtime.workspace,
        providerLabel: resolved.preset.label,
        model: resolved.model,
        offline: resolved.preset.kind === 'offline',
        tools,
        mcpSummary,
        skillsContext,
        sessionId: runtime.sessionId,
      }),
    },
    ...history.slice(-16).map((message) => ({ role: message.role, content: message.content })),
    { role: 'user', content: input },
  ];

  yield { type: 'status', message: `${resolved.preset.label} · ${resolved.model}` };

  const maxSteps = runtime.maxSteps ?? 6;
  let totalUsage: TokenUsage = { prompt: 0, completion: 0, total: 0 };

  for (let step = 1; step <= maxSteps; step += 1) {
    if (signal.aborted) return;

    let text = '';
    let usage: TokenUsage | undefined;
    let streamError: string | undefined;

    try {
      for await (const chunk of resolved.provider.stream({
        messages,
        temperature: config.model.temperature,
        maxTokens: config.model.maxTokens,
        signal,
        tools: tools.map((tool) => tool.name),
      })) {
        if (signal.aborted) return;
        if (chunk.error) {
          streamError = chunk.error;
          break;
        }
        if (chunk.text) {
          text += chunk.text;
          yield { type: 'delta', text: chunk.text };
        }
        if (chunk.usage) usage = chunk.usage;
      }
    } catch (error) {
      if (signal.aborted) return;
      yield { type: 'error', message: `Model call failed: ${(error as Error).message}` };
      return;
    }

    if (streamError) {
      yield { type: 'error', message: streamError };
      return;
    }

    const visible = stripToolBlocks(text);
    if (visible) {
      // The provider already streamed this text; emit the final form so the UI
      // can replace the streaming buffer with rendered markdown.
      yield { type: 'assistant', text: visible };
    }

    messages.push({ role: 'assistant', content: text || '(empty)' });

    if (usage) {
      totalUsage = addUsage(totalUsage, usage);
      yield { type: 'usage', usage: totalUsage };
      recordUsage({
        provider: resolved.preset.id,
        model: resolved.model,
        prompt: usage.prompt,
        completion: usage.completion,
        total: usage.total,
      });
    }

    const calls = parseToolCalls(text);
    if (calls.length === 0) {
      if (!visible) {
        yield { type: 'error', message: 'The model returned an empty response.' };
        return;
      }
      yield { type: 'done', steps: step };
      return;
    }

    for (const call of calls) {
      if (signal.aborted) return;
      const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
      const tool = runtime.toolkit.find(call.name);

      if (!tool) {
        const output = `Unknown tool "${call.name}". Use only tools from the catalog.`;
        yield { type: 'tool_result', id, name: call.name, ok: false, output, durationMs: 0 };
        messages.push({ role: 'user', content: resultBlock(call.name, false, output) });
        continue;
      }

      yield { type: 'tool_call', id, name: call.name, args: call.args };

      const needsApproval =
        (tool.danger === 'write' && !config.permissions.allowWrite) ||
        (tool.danger === 'dangerous' && !config.permissions.allowDangerous);

      if (needsApproval) {
        yield { type: 'approval_required', id, name: call.name, danger: tool.danger, args: call.args };
        const approved = await runtime.approve({
          tool: call.name,
          danger: tool.danger,
          args: call.args,
          summary: summarizeArgs(call.name, call.args),
        });
        if (!approved) {
          const output = 'The user denied this action. Do not retry it without being asked explicitly.';
          yield { type: 'tool_result', id, name: call.name, ok: false, output, durationMs: 0 };
          messages.push({ role: 'user', content: resultBlock(call.name, false, output) });
          continue;
        }
      }

      const started = Date.now();
      const result = await runtime.toolkit.execute(call.name, call.args, {
        workspace: runtime.workspace,
        home: runtime.home,
        config,
        sessionId: runtime.sessionId,
        signal,
        log: runtime.log,
      });
      const durationMs = Date.now() - started;
      const output = capOutput(result.output ?? '', 9000);

      yield { type: 'tool_result', id, name: call.name, ok: result.ok, output, durationMs };
      messages.push({ role: 'user', content: resultBlock(call.name, result.ok, output) });
      runtime.log(`tool ${call.name} ${result.ok ? 'ok' : 'failed'} (${durationMs}ms)`);
    }
  }

  yield {
    type: 'error',
    message: `Stopped after ${maxSteps} reasoning steps to avoid a loop. Ask me to continue if you want to keep going.`,
  };
}
