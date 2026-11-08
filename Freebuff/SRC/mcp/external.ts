import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { log } from '../utils/logger';
import { paths } from '../utils/paths';
import { defineTool, toolFail, toolOk, type McpModule, type ToolDef } from './types';

/**
 * External MCP servers.
 *
 * Users can add any stdio MCP server by dropping a manifest into
 * `~/.ai-freebuff/mcp/<name>.json` (or by asking the agent to install one).
 * Manifests use the familiar shape:
 *
 *   { "name": "filesystem", "command": "npx",
 *     "args": ["-y", "@modelcontextprotocol/server-filesystem", "/sdcard"] }
 *
 * The client speaks newline-delimited JSON-RPC 2.0, which is what the MCP
 * stdio transport specifies.
 */

export interface ExternalMcpManifest {
  id?: string;
  name: string;
  description?: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  enabled?: boolean;
}

interface PendingRequest {
  resolve: (value: any) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

class StdioClient {
  private child: ChildProcessWithoutNullStreams | null = null;
  private buffer = '';
  private nextId = 1;
  private pending = new Map<number, PendingRequest>();
  private initialized = false;

  constructor(private manifest: ExternalMcpManifest) {}

  async connect(timeoutMs = 20_000): Promise<void> {
    const child = spawn(this.manifest.command, this.manifest.args ?? [], {
      env: { ...process.env, ...(this.manifest.env ?? {}) },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child = child;

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => this.onData(chunk));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => log.debug(`[mcp:${this.manifest.name}] ${chunk.trim().slice(0, 400)}`));
    child.on('exit', (code) => {
      log.warn(`external MCP ${this.manifest.name} exited`, { code });
      for (const [, pending] of this.pending) {
        clearTimeout(pending.timer);
        pending.reject(new Error(`MCP server exited (code ${code})`));
      }
      this.pending.clear();
      this.initialized = false;
    });
    child.on('error', (error) => {
      log.warn(`external MCP ${this.manifest.name} spawn error`, { error: error.message });
    });

    await this.request(
      'initialize',
      {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'ai-freebuff-mcp-termux', version: '1.0.0' },
      },
      timeoutMs,
    );
    this.notify('notifications/initialized', {});
    this.initialized = true;
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let newlineIndex = this.buffer.indexOf('\n');
    while (newlineIndex >= 0) {
      const line = this.buffer.slice(0, newlineIndex).trim();
      this.buffer = this.buffer.slice(newlineIndex + 1);
      newlineIndex = this.buffer.indexOf('\n');
      if (!line) continue;
      let message: any;
      try {
        message = JSON.parse(line);
      } catch {
        continue; // Not a JSON-RPC frame (banner/log line).
      }
      if (typeof message.id === 'number' && this.pending.has(message.id)) {
        const pending = this.pending.get(message.id)!;
        this.pending.delete(message.id);
        clearTimeout(pending.timer);
        if (message.error) pending.reject(new Error(message.error.message ?? 'MCP error'));
        else pending.resolve(message.result);
      }
    }
  }

  request(method: string, params: unknown, timeoutMs = 25_000): Promise<any> {
    if (!this.child) return Promise.reject(new Error('MCP server not running'));
    const id = this.nextId++;
    const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP request timed out: ${method}`));
      }, timeoutMs);
      if (typeof timer.unref === 'function') timer.unref();
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.child!.stdin.write(payload);
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  notify(method: string, params: unknown): void {
    if (!this.child) return;
    try {
      this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
    } catch {
      /* server already gone */
    }
  }

  async listTools(): Promise<Array<{ name: string; description?: string; inputSchema?: unknown }>> {
    if (!this.initialized) throw new Error('MCP client not initialized');
    const result = await this.request('tools/list', {});
    return Array.isArray(result?.tools) ? result.tools : [];
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<{ ok: boolean; text: string }> {
    const result = await this.request('tools/call', { name, arguments: args }, 120_000);
    const content = Array.isArray(result?.content) ? result.content : [];
    const text = content
      .map((item: any) => {
        if (item?.type === 'text') return String(item.text ?? '');
        if (item?.type === 'image') return `[image ${item.mimeType ?? ''} ${item.data ? `${String(item.data).length} b64 chars` : ''}]`;
        return JSON.stringify(item);
      })
      .join('\n')
      .trim();
    const isError = Boolean(result?.isError);
    return { ok: !isError, text: text || (isError ? 'MCP tool reported an error.' : 'ok') };
  }

  close(): void {
    try {
      this.child?.kill('SIGTERM');
    } catch {
      /* ignore */
    }
    this.child = null;
  }
}

function sanitizeId(input: string): string {
  return input.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'external';
}

/** Turn a manifest into an in-process MCP module backed by a stdio server. */
export async function moduleFromManifest(manifest: ExternalMcpManifest): Promise<McpModule | null> {
  const id = sanitizeId(manifest.id ?? manifest.name);
  const client = new StdioClient(manifest);
  try {
    await client.connect();
    const remoteTools = await client.listTools();
    const tools: ToolDef[] = remoteTools.map((remote) =>
      defineTool({
        name: `${id}_${sanitizeId(remote.name)}`,
        title: `${manifest.name}: ${remote.name}`,
        description: remote.description ?? `External MCP tool ${remote.name}`,
        params: 'arguments:object',
        schema: z.record(z.unknown()),
        danger: 'write',
        async run(args) {
          try {
            const result = await client.callTool(remote.name, (args as Record<string, unknown>) ?? {});
            return result.ok ? toolOk(result.text) : toolFail(result.text);
          } catch (error) {
            return toolFail(`MCP call failed: ${(error as Error).message}`);
          }
        },
      }),
    );

    return {
      id,
      name: manifest.name,
      blurb: manifest.description ?? 'User-installed stdio MCP server',
      version: 'external',
      tools,
      async probe() {
        return { status: tools.length ? 'ready' : 'degraded', detail: `${tools.length} tool(s) via stdio` };
      },
      dispose() {
        client.close();
      },
    };
  } catch (error) {
    log.warn(`could not start external MCP ${manifest.name}`, { error: (error as Error).message });
    client.close();
    return null;
  }
}

/** Load every `~/.ai-freebuff/mcp/*.json` manifest. */
export async function loadExternalMcps(): Promise<McpModule[]> {
  const modules: McpModule[] = [];
  let entries: string[] = [];
  try {
    entries = await fs.readdir(paths.mcp);
  } catch {
    return modules;
  }
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    if (entry.startsWith('registry')) continue;
    try {
      const manifest = JSON.parse(await fs.readFile(path.join(paths.mcp, entry), 'utf8')) as ExternalMcpManifest;
      if (!manifest.command || manifest.enabled === false) continue;
      const module = await moduleFromManifest(manifest);
      if (module) modules.push(module);
    } catch (error) {
      log.warn(`invalid MCP manifest ${entry}`, { error: (error as Error).message });
    }
  }
  return modules;
}

export const MANIFEST_TEMPLATE: ExternalMcpManifest = {
  name: 'my-mcp',
  description: 'Example stdio MCP server',
  command: 'npx',
  args: ['-y', '@modelcontextprotocol/server-everything'],
  enabled: true,
};
