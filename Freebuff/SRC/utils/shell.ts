import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Thin, promise-based wrapper around `spawn`.
 *
 * Tools never pass user input through a shell: arguments are always arrays.
 * `runBash()` exists for the rare cases where shell semantics are the point
 * (pipelines inside Termux) and is only reachable from the explicit,
 * permission-gated `sys_shell` tool.
 */

export interface RunOptions {
  cwd?: string;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  input?: string;
  maxBuffer?: number;
  signal?: AbortSignal;
}

export interface RunResult {
  command: string;
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
  error?: string;
}

export interface BinaryResult {
  command: string;
  code: number | null;
  stdout: Buffer;
  stderr: string;
  timedOut: boolean;
  error?: string;
}

const DEFAULT_MAX_BUFFER = 4 * 1024 * 1024;
const DEFAULT_TIMEOUT = 60_000;
const SAFE_COMMAND = /^[A-Za-z0-9._+-]+$/;

const commandCache = new Map<string, boolean>();

function toText(value: string | Buffer): string {
  return typeof value === 'string' ? value : value.toString('utf8');
}

export function run(command: string, args: string[] = [], options: RunOptions = {}): Promise<RunResult> {
  return new Promise<RunResult>((resolve) => {
    const started = Date.now();
    const maxBuffer = options.maxBuffer ?? DEFAULT_MAX_BUFFER;
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT;
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    let timer: NodeJS.Timeout | undefined;

    const finish = (code: number | null, error?: string): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (options.signal) options.signal.removeEventListener('abort', onAbort);
      resolve({
        command: [command, ...args].join(' '),
        code,
        stdout,
        stderr,
        timedOut,
        durationMs: Date.now() - started,
        error,
      });
    };

    const onAbort = (): void => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
      finish(null, 'aborted');
    };

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, args, {
        cwd: options.cwd,
        env: { ...process.env, ...options.env },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (spawnError) {
      resolve({
        command: [command, ...args].join(' '),
        code: null,
        stdout: '',
        stderr: '',
        timedOut: false,
        durationMs: Date.now() - started,
        error: spawnError instanceof Error ? spawnError.message : String(spawnError),
      });
      return;
    }

    timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill('SIGKILL');
      } catch {
        /* ignore */
      }
    }, timeoutMs);
    // Never keep the event loop alive just because a timeout is pending.
    if (typeof timer.unref === 'function') timer.unref();

    if (options.signal) {
      if (options.signal.aborted) {
        onAbort();
      } else {
        options.signal.addEventListener('abort', onAbort, { once: true });
      }
    }

    child.stdout?.on('data', (chunk: Buffer) => {
      if (stdout.length >= maxBuffer) return;
      stdout += toText(chunk);
      if (stdout.length > maxBuffer) stdout = stdout.slice(0, maxBuffer) + '\n… [output truncated]';
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length >= 64_000) return;
      stderr += toText(chunk);
      if (stderr.length > 64_000) stderr = stderr.slice(0, 64_000) + '\n… [stderr truncated]';
    });

    child.on('error', (err: NodeJS.ErrnoException) => {
      const message = err.code === 'ENOENT' ? `command not found: ${command}` : err.message;
      finish(null, message);
    });
    child.on('close', (code: number | null) => {
      finish(timedOut ? null : code);
    });

    if (options.input !== undefined && child.stdin) {
      child.stdin.end(options.input);
    } else if (child.stdin) {
      child.stdin.end();
    }
  });
}

/** Run a bash script through `bash -lc` (used by setup-ish helper tools only). */
export function runBash(script: string, options: RunOptions = {}): Promise<RunResult> {
  return run('bash', ['-lc', script], options);
}

/** Run a command and capture raw bytes (screenshots, APK signatures, …). */
export function runBinary(command: string, args: string[] = [], options: RunOptions = {}): Promise<BinaryResult> {
  return new Promise<BinaryResult>((resolve) => {
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT;
    const chunks: Buffer[] = [];
    let stderr = '';
    let timedOut = false;
    let settled = false;
    let timer: NodeJS.Timeout | undefined;

    const finish = (code: number | null, error?: string): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({ command: [command, ...args].join(' '), code, stdout: Buffer.concat(chunks), stderr, timedOut, error });
    };

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, args, { cwd: options.cwd, env: { ...process.env, ...options.env }, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (spawnError) {
      resolve({
        command: [command, ...args].join(' '),
        code: null,
        stdout: Buffer.alloc(0),
        stderr: '',
        timedOut: false,
        error: spawnError instanceof Error ? spawnError.message : String(spawnError),
      });
      return;
    }

    timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill('SIGKILL');
      } catch {
        /* ignore */
      }
    }, timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();

    child.stdout?.on('data', (chunk: Buffer) => chunks.push(chunk));
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', (err: NodeJS.ErrnoException) => {
      finish(null, err.code === 'ENOENT' ? `command not found: ${command}` : err.message);
    });
    child.on('close', (code: number | null) => finish(timedOut ? null : code));
  });
}

/** Cached `command -v` lookup. Uses PATH scanning, no shell interpolation. */
export async function hasCommand(command: string): Promise<boolean> {
  if (!SAFE_COMMAND.test(command)) return false;
  const cached = commandCache.get(command);
  if (cached !== undefined) return cached;

  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  let found = false;
  for (const dir of dirs) {
    const candidate = path.join(dir, command);
    try {
      const stat = fs.statSync(candidate);
      if (stat.isFile()) {
        fs.accessSync(candidate, fs.constants.X_OK);
        found = true;
        break;
      }
    } catch {
      /* keep looking */
    }
  }

  // Fall back to the shell for Termux wrappers/aliases that are not plain files.
  if (!found) {
    const result = await run('sh', ['-c', `command -v -- ${command} >/dev/null 2>&1`], { timeoutMs: 4000 });
    found = result.code === 0;
  }

  commandCache.set(command, found);
  return found;
}

/** Forget cached lookups (used after `pkg install` from inside the app). */
export function clearCommandCache(): void {
  commandCache.clear();
}

/** First available command from a list, or null. */
export async function firstCommand(candidates: readonly string[]): Promise<string | null> {
  for (const candidate of candidates) {
    if (await hasCommand(candidate)) return candidate;
  }
  return null;
}

export function commandExistsSync(command: string): boolean {
  if (!SAFE_COMMAND.test(command)) return false;
  return (process.env.PATH || '')
    .split(path.delimiter)
    .filter(Boolean)
    .some((dir) => {
      try {
        fs.accessSync(path.join(dir, command), fs.constants.X_OK);
        return true;
      } catch {
        return false;
      }
    });
}

/** Quote a value for safe inclusion in a bash command string. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
