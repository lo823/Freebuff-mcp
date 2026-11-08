import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Central path resolution.
 *
 * Everything the app writes lives under `AI_FREEBUFF_HOME`
 * (default: `~/.ai-freebuff`), so uninstalling is a single `rm -rf`.
 * The user's *workspace* is separate: tools that touch project files are
 * sandboxed to it.
 */

export const isTermux: boolean =
  Boolean(process.env.TERMUX_VERSION) ||
  Boolean(process.env.PREFIX && process.env.PREFIX.includes('com.termux'));

export const homeDir: string = process.env.HOME || os.homedir();
export const prefixDir: string = process.env.PREFIX || (isTermux ? '/data/data/com.termux/files/usr' : '/usr');

export const appHome: string = process.env.AI_FREEBUFF_HOME
  ? path.resolve(process.env.AI_FREEBUFF_HOME)
  : path.join(homeDir, '.ai-freebuff');

export const paths = {
  home: appHome,
  config: path.join(appHome, 'config.json'),
  logDir: path.join(appHome, 'logs'),
  log: path.join(appHome, 'logs', 'ai-freebuff.log'),
  sessions: path.join(appHome, 'sessions'),
  skills: path.join(appHome, 'skills'),
  mcp: path.join(appHome, 'mcp'),
  cache: path.join(appHome, 'cache'),
  rea: path.join(appHome, 'rea'),
  reports: path.join(appHome, 'reports'),
  usage: path.join(appHome, 'usage.json'),
  state: path.join(appHome, 'state.json'),
  workspace: process.env.AI_FREEBUFF_WORKSPACE
    ? path.resolve(process.env.AI_FREEBUFF_WORKSPACE)
    : path.join(homeDir, 'ai-freebuff-workspace'),
} as const;

/** Create every directory the app expects. Safe to call repeatedly. */
export function ensureAppDirs(): void {
  const dirs = [
    paths.home,
    paths.logDir,
    paths.sessions,
    paths.skills,
    paths.mcp,
    paths.cache,
    paths.reports,
    paths.workspace,
  ];
  for (const dir of dirs) {
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch {
      // A read-only home is not fatal: individual tools will report the error.
    }
  }
}

/** Collapse `$HOME` back to `~` for display purposes. */
export function prettyPath(target: string): string {
  if (target === homeDir) return '~';
  if (target.startsWith(homeDir + path.sep)) return `~${target.slice(homeDir.length)}`;
  return target;
}
