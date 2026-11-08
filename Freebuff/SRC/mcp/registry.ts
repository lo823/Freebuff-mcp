import type { AppConfig } from '../utils/config';
import { isMcpEnabled } from '../utils/config';
import { log } from '../utils/logger';
import { androidMcp } from './android';
import { chatMcp } from './chat';
import { loadExternalMcps } from './external';
import { fileMcp } from './file';
import { githubMcp } from './github';
import { godotMcp } from './godot';
import { modelMcp } from './model';
import { playwrightMcp } from './playwright';
import { reaMcp } from './rea';
import { termuxMcp } from './termux';
import type { McpHealth, McpModule, ToolDef } from './types';

/**
 * Registry of every MCP server, built-in or user-installed.
 *
 * Health probes run with a hard timeout so a hung `adb` or a dead external
 * server can never freeze the TUI.
 */

const BUILTIN: McpModule[] = [
  androidMcp,
  fileMcp,
  godotMcp,
  chatMcp,
  modelMcp,
  githubMcp,
  reaMcp,
  playwrightMcp,
  termuxMcp,
];

function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise<T>((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms);
    if (typeof timer.unref === 'function') timer.unref();
    promise
      .then((value) => resolve(value))
      .catch(() =>
        resolve({
          status: 'unavailable',
          detail: 'probe failed',
        } as unknown as T),
      )
      .finally(() => clearTimeout(timer));
  });
}

export class McpRegistry {
  private modules = new Map<string, McpModule>();
  private health = new Map<string, McpHealth>();
  private initialized = false;

  constructor(private config: AppConfig) {}

  async init(options: { includeExternal?: boolean } = {}): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;
    for (const module of BUILTIN) this.modules.set(module.id, module);
    if (options.includeExternal !== false) {
      try {
        const external = await loadExternalMcps();
        for (const module of external) this.modules.set(module.id, module);
      } catch (error) {
        log.warn('external MCP discovery failed', { error: (error as Error).message });
      }
    }
  }

  /** Re-read config so toggles take effect without a restart. */
  refresh(config: AppConfig): void {
    this.config = config;
  }

  list(): McpModule[] {
    return [...this.modules.values()];
  }

  get(id: string): McpModule | undefined {
    return this.modules.get(id);
  }

  isEnabled(id: string): boolean {
    return isMcpEnabled(this.config, id);
  }

  enabled(): McpModule[] {
    return this.list().filter((module) => this.isEnabled(module.id));
  }

  /** Every tool from every enabled MCP. */
  tools(): ToolDef[] {
    return this.enabled().flatMap((module) => module.tools);
  }

  findTool(name: string): { tool: ToolDef; module: McpModule } | undefined {
    for (const module of this.enabled()) {
      const tool = module.tools.find((candidate) => candidate.name === name);
      if (tool) return { tool, module };
    }
    return undefined;
  }

  async probeAll(): Promise<Record<string, McpHealth>> {
    const entries = await Promise.all(
      this.list().map(async (module) => {
        const health = await withTimeout<McpHealth>(module.probe(), 5000, {
          status: 'degraded',
          detail: 'probe timed out',
        });
        this.health.set(module.id, health);
        return [module.id, health] as const;
      }),
    );
    return Object.fromEntries(entries);
  }

  getHealth(id: string): McpHealth {
    return this.health.get(id) ?? { status: 'degraded', detail: 'not probed yet' };
  }

  healthMap(): Record<string, McpHealth> {
    return Object.fromEntries(this.health.entries());
  }

  toolCount(): number {
    return this.tools().length;
  }

  async dispose(): Promise<void> {
    for (const module of this.modules.values()) {
      try {
        await module.dispose?.();
      } catch {
        /* best-effort shutdown */
      }
    }
  }
}
