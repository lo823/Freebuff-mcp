import fs from 'node:fs';
import path from 'node:path';
import { ensureAppDirs, paths, isTermux } from './paths';

/** Shape of `~/.ai-freebuff/config.json`. Everything is optional on disk. */
export interface AppConfig {
  version: number;
  model: {
    provider: string;
    model: string;
    baseUrl: string;
    temperature: number;
    maxTokens: number;
  };
  workspace: string;
  permissions: {
    autoApproveSafe: boolean;
    allowWrite: boolean;
    allowDangerous: boolean;
  };
  ui: {
    splash: boolean;
    animations: boolean;
    compact: boolean;
    showToolOutput: boolean;
  };
  mcp: Record<string, { enabled: boolean }>;
  skills: {
    active: string[];
    autoActivate: boolean;
  };
  updatedAt: string;
}

export const MCP_IDS = [
  'android',
  'file',
  'godot',
  'chat',
  'model',
  'github',
  'rea',
  'playwright',
  'termux',
] as const;

export type McpId = (typeof MCP_IDS)[number];

function defaultMcpState(): Record<string, { enabled: boolean }> {
  const state: Record<string, { enabled: boolean }> = {};
  for (const id of MCP_IDS) state[id] = { enabled: true };
  return state;
}

export function defaultConfig(): AppConfig {
  return {
    version: 1,
    model: {
      provider: process.env.AI_FREEBUFF_PROVIDER || 'auto',
      model: process.env.AI_FREEBUFF_MODEL || '',
      baseUrl: process.env.AI_FREEBUFF_BASE_URL || '',
      temperature: Number(process.env.AI_FREEBUFF_TEMPERATURE || 0.4),
      maxTokens: Number(process.env.AI_FREEBUFF_MAX_TOKENS || 2048),
    },
    workspace: paths.workspace,
    permissions: {
      autoApproveSafe: true,
      allowWrite: false,
      allowDangerous: false,
    },
    ui: {
      splash: true,
      animations: true,
      compact: false,
      showToolOutput: true,
    },
    mcp: defaultMcpState(),
    skills: {
      active: [],
      autoActivate: true,
    },
    updatedAt: new Date().toISOString(),
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Recursive merge that keeps defaults for anything missing on disk. */
function merge<T>(base: T, override: unknown): T {
  if (!isPlainObject(base) || !isPlainObject(override)) {
    return (override === undefined ? base : (override as T));
  }
  const result: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (value === undefined) continue;
    const current = (base as Record<string, unknown>)[key];
    result[key] = isPlainObject(current) && isPlainObject(value) ? merge(current, value) : value;
  }
  return result as T;
}

export function loadConfig(): AppConfig {
  ensureAppDirs();
  const base = defaultConfig();
  let stored: unknown = {};
  try {
    if (fs.existsSync(paths.config)) {
      stored = JSON.parse(fs.readFileSync(paths.config, 'utf8')) as unknown;
    }
  } catch {
    // Corrupt config: keep defaults, the next save repairs the file.
    stored = {};
  }

  const merged = merge(base, stored);

  // `auto` means "pick the best configured provider at runtime".
  merged.model.provider = merged.model.provider || 'auto';
  merged.workspace = process.env.AI_FREEBUFF_WORKSPACE || merged.workspace || base.workspace;
  merged.workspace = path.resolve(merged.workspace);
  merged.updatedAt = new Date().toISOString();

  // A Termux phone screen is small: default to the compact layout there.
  if (isTermux && stored && isPlainObject(stored) && !isPlainObject(stored.ui)) {
    merged.ui.compact = true;
  }

  return merged;
}

/** Atomic save so a killed process never leaves half a JSON file behind. */
export function saveConfig(config: AppConfig): void {
  ensureAppDirs();
  config.updatedAt = new Date().toISOString();
  const tmp = `${paths.config}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, paths.config);
}

export function updateConfig(patch: Partial<AppConfig>): AppConfig {
  const next = merge(loadConfig(), patch as unknown);
  saveConfig(next);
  return next;
}

/** True when the MCP is enabled in config (unknown ids default to enabled). */
export function isMcpEnabled(config: AppConfig, id: string): boolean {
  return config.mcp[id]?.enabled !== false;
}

export function setMcpEnabled(id: string, enabled: boolean): AppConfig {
  const config = loadConfig();
  config.mcp[id] = { enabled };
  saveConfig(config);
  return config;
}

/** Human-readable summary used by `--doctor` and the model MCP. */
export function describeConfig(config: AppConfig): string[] {
  return [
    `workspace : ${config.workspace}`,
    `provider  : ${config.model.provider}${config.model.model ? ` (${config.model.model})` : ''}`,
    `approvals : safe=${config.permissions.autoApproveSafe} write=${config.permissions.allowWrite} dangerous=${config.permissions.allowDangerous}`,
    `mcp       : ${Object.entries(config.mcp)
      .filter(([, v]) => v.enabled)
      .map(([k]) => k)
      .join(', ')}`,
    `skills    : ${config.skills.active.length ? config.skills.active.join(', ') : 'none active'}`,
  ];
}
