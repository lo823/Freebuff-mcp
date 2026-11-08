import fs from 'node:fs';
import { ensureAppDirs, paths } from './paths';

/**
 * File logger. The TUI owns stdout, so diagnostics must never go there or
 * they will shred the Ink frame. Logs land in ~/.ai-freebuff/logs.
 */

type Level = 'debug' | 'info' | 'warn' | 'error';

const MAX_LOG_BYTES = 1_500_000;
const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/sk-[A-Za-z0-9_-]{16,}/g, 'sk-***'],
  [/gh[pousr]_[A-Za-z0-9]{20,}/g, 'gh*_***'],
  [/Bearer\s+[A-Za-z0-9._-]{12,}/gi, 'Bearer ***'],
  [/("(?:api[_-]?key|token|secret)"\s*:\s*")[^"]+(")/gi, '$1***$2'],
];

function redact(input: string): string {
  let output = input;
  for (const [pattern, replacement] of SECRET_PATTERNS) output = output.replace(pattern, replacement);
  return output;
}

function rotateIfNeeded(): void {
  try {
    const stat = fs.statSync(paths.log);
    if (stat.size > MAX_LOG_BYTES) fs.renameSync(paths.log, `${paths.log}.1`);
  } catch {
    /* no log yet */
  }
}

export function logLine(level: Level, message: string, meta?: unknown): void {
  try {
    ensureAppDirs();
    rotateIfNeeded();
    const suffix = meta === undefined ? '' : ` ${safeStringify(meta)}`;
    fs.appendFileSync(paths.log, `[${new Date().toISOString()}] ${level.toUpperCase()} ${redact(message)}${suffix}\n`, 'utf8');
  } catch {
    // Logging must never crash the app.
  }
}

function safeStringify(value: unknown): string {
  if (value instanceof Error) return redact(`${value.name}: ${value.message}`);
  try {
    return redact(JSON.stringify(value));
  } catch {
    return redact(String(value));
  }
}

export const log = {
  debug: (message: string, meta?: unknown): void => logLine('debug', message, meta),
  info: (message: string, meta?: unknown): void => logLine('info', message, meta),
  warn: (message: string, meta?: unknown): void => logLine('warn', message, meta),
  error: (message: string, meta?: unknown): void => logLine('error', message, meta),
};

/** Last N lines of the log, for the in-app log viewer and `--doctor`. */
export function readLogTail(lines = 60): string[] {
  try {
    const content = fs.readFileSync(paths.log, 'utf8');
    return content.trimEnd().split('\n').slice(-lines);
  } catch {
    return [];
  }
}
