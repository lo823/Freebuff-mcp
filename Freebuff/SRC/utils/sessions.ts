import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { ensureAppDirs, paths } from './paths';

/** Append-only JSONL transcripts, one file per TUI session. */

export type StoredRole = 'user' | 'assistant' | 'system' | 'tool';

export interface StoredMessage {
  id: string;
  role: StoredRole;
  content: string;
  at: string;
  meta?: Record<string, unknown>;
}

export interface SessionSummary {
  id: string;
  file: string;
  messages: number;
  title: string;
  updatedAt: string;
  bytes: number;
}

const SAFE_ID = /^[A-Za-z0-9._-]+$/;

export function newSessionId(): string {
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  return `${stamp}-${Math.random().toString(36).slice(2, 8)}`;
}

export function sessionPath(sessionId: string): string {
  const safe = SAFE_ID.test(sessionId) ? sessionId : 'default';
  return path.join(paths.sessions, `${safe}.jsonl`);
}

export async function appendStoredMessage(sessionId: string, message: Omit<StoredMessage, 'id' | 'at'> & Partial<Pick<StoredMessage, 'id' | 'at'>>): Promise<void> {
  ensureAppDirs();
  const record: StoredMessage = {
    id: message.id ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    at: message.at ?? new Date().toISOString(),
    role: message.role,
    content: message.content,
    meta: message.meta,
  };
  await fsp.appendFile(sessionPath(sessionId), `${JSON.stringify(record)}\n`, 'utf8');
}

export async function readSession(sessionId: string, limit = 200): Promise<StoredMessage[]> {
  try {
    const raw = await fsp.readFile(sessionPath(sessionId), 'utf8');
    const messages: StoredMessage[] = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        messages.push(JSON.parse(line) as StoredMessage);
      } catch {
        /* skip corrupt line */
      }
    }
    return messages.slice(-limit);
  } catch {
    return [];
  }
}

export async function listSessions(): Promise<SessionSummary[]> {
  ensureAppDirs();
  const entries = await fsp.readdir(paths.sessions).catch(() => [] as string[]);
  const summaries: SessionSummary[] = [];
  for (const entry of entries) {
    if (!entry.endsWith('.jsonl')) continue;
    const file = path.join(paths.sessions, entry);
    try {
      const [raw, stat] = await Promise.all([fsp.readFile(file, 'utf8'), fsp.stat(file)]);
      const lines = raw.split('\n').filter((line) => line.trim() !== '');
      let title = '(empty session)';
      for (const line of lines) {
        try {
          const parsed = JSON.parse(line) as StoredMessage;
          if (parsed.role === 'user' && parsed.content.trim()) {
            title = parsed.content.replace(/\s+/g, ' ').slice(0, 70);
            break;
          }
        } catch {
          /* ignore */
        }
      }
      summaries.push({
        id: entry.replace(/\.jsonl$/, ''),
        file,
        messages: lines.length,
        title,
        updatedAt: stat.mtime.toISOString(),
        bytes: stat.size,
      });
    } catch {
      /* unreadable */
    }
  }
  return summaries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function searchSessions(query: string, limit = 20): Promise<Array<{ session: string; role: string; text: string; at: string }>> {
  const needle = query.toLowerCase();
  const results: Array<{ session: string; role: string; text: string; at: string }> = [];
  const sessions = await listSessions();
  for (const session of sessions) {
    if (results.length >= limit) break;
    const messages = await readSession(session.id, 500);
    for (const message of messages) {
      if (results.length >= limit) break;
      if (!message.content.toLowerCase().includes(needle)) continue;
      results.push({
        session: session.id,
        role: message.role,
        text: message.content.replace(/\s+/g, ' ').slice(0, 200),
        at: message.at,
      });
    }
  }
  return results;
}

export function exportSessionMarkdown(sessionId: string, messages: StoredMessage[]): string {
  const header = `# AI-FREEBUFF session ${sessionId}\n\nExported ${new Date().toISOString()}\n\n---\n\n`;
  const body = messages
    .map((message) => {
      const label = message.role === 'user' ? 'You' : message.role === 'assistant' ? 'AI-FREEBUFF' : message.role;
      return `## ${label} · ${message.at}\n\n${message.content}\n`;
    })
    .join('\n');
  return header + body;
}

export function truncateSession(sessionId: string): void {
  const file = sessionPath(sessionId);
  try {
    if (fs.existsSync(file)) fs.writeFileSync(file, '', 'utf8');
  } catch {
    /* nothing to do */
  }
}
