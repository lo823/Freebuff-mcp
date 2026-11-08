import type { z } from 'zod';
import type { AppConfig } from '../utils/config';

/**
 * Every MCP in this project is an in-process module that exposes a list of
 * typed tools. That keeps startup instant on a phone (no child processes, no
 * handshake) while still presenting the same "tools" surface an external MCP
 * server would via `external.ts`.
 */

export type DangerLevel = 'safe' | 'write' | 'dangerous';

export interface ToolContext {
  /** Sandbox root for file operations. */
  workspace: string;
  /** `~/.ai-freebuff` — sessions, skills, reports. */
  home: string;
  config: AppConfig;
  sessionId: string;
  signal?: AbortSignal;
  /** Routes to the in-app log viewer + log file. */
  log: (message: string) => void;
}

export interface ToolResult {
  ok: boolean;
  output: string;
  data?: unknown;
}

export interface ToolDef {
  name: string;
  title: string;
  description: string;
  /** Compact signature shown to the model, e.g. `path:string, limit?:number`. */
  params: string;
  schema: z.ZodTypeAny;
  danger: DangerLevel;
  run: (args: any, ctx: ToolContext) => Promise<ToolResult>;
}

/** Helper that preserves argument inference at the definition site. */
export function defineTool<S extends z.ZodTypeAny>(definition: {
  name: string;
  title: string;
  description: string;
  params: string;
  schema: S;
  danger: DangerLevel;
  run: (args: z.infer<S>, ctx: ToolContext) => Promise<ToolResult>;
}): ToolDef {
  return definition as unknown as ToolDef;
}

export type McpStatus = 'ready' | 'degraded' | 'unavailable';

export interface McpHealth {
  status: McpStatus;
  detail: string;
}

export interface McpModule {
  id: string;
  name: string;
  blurb: string;
  version: string;
  tools: ToolDef[];
  /** Cheap capability probe run at startup and on refresh. */
  probe: () => Promise<McpHealth>;
  dispose?: () => Promise<void> | void;
}

export function toolOk(output: string, data?: unknown): ToolResult {
  return { ok: true, output, data };
}

export function toolFail(output: string): ToolResult {
  return { ok: false, output };
}

/** One-line description of a tool for the model prompt. */
export function describeTool(tool: ToolDef): string {
  return `- ${tool.name}(${tool.params}) [${tool.danger}] — ${tool.description}`;
}
