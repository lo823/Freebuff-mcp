import fs from 'node:fs';
import { ensureAppDirs, paths } from './paths';
import type { TokenUsage } from '../agent/model-router';

/** Token accounting ledger, shown in the status bar and the model MCP. */

export interface UsageEntry extends TokenUsage {
  at: string;
  provider: string;
  model: string;
}

interface UsageFile {
  version: number;
  total: TokenUsage;
  entries: UsageEntry[];
}

const MAX_ENTRIES = 250;

function empty(): UsageFile {
  return { version: 1, total: { prompt: 0, completion: 0, total: 0 }, entries: [] };
}

export function readUsage(): UsageFile {
  ensureAppDirs();
  try {
    if (!fs.existsSync(paths.usage)) return empty();
    const parsed = JSON.parse(fs.readFileSync(paths.usage, 'utf8')) as Partial<UsageFile>;
    return {
      version: parsed.version ?? 1,
      total: {
        prompt: parsed.total?.prompt ?? 0,
        completion: parsed.total?.completion ?? 0,
        total: parsed.total?.total ?? 0,
      },
      entries: Array.isArray(parsed.entries) ? parsed.entries : [],
    };
  } catch {
    return empty();
  }
}

export function recordUsage(entry: Omit<UsageEntry, 'at'> & { at?: string }): UsageFile {
  const ledger = readUsage();
  const full: UsageEntry = { ...entry, at: entry.at ?? new Date().toISOString() };
  ledger.total = {
    prompt: ledger.total.prompt + full.prompt,
    completion: ledger.total.completion + full.completion,
    total: ledger.total.total + full.total,
  };
  ledger.entries = [...ledger.entries, full].slice(-MAX_ENTRIES);
  try {
    fs.writeFileSync(paths.usage, `${JSON.stringify(ledger, null, 2)}\n`, 'utf8');
  } catch {
    /* accounting is best-effort */
  }
  return ledger;
}

export function resetUsage(): void {
  try {
    fs.writeFileSync(paths.usage, `${JSON.stringify(empty(), null, 2)}\n`, 'utf8');
  } catch {
    /* best-effort */
  }
}
