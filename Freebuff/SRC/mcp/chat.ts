import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { formatBytes } from '../utils/text';
import {
  appendStoredMessage,
  exportSessionMarkdown,
  listSessions,
  readSession,
  searchSessions,
  truncateSession,
} from '../utils/sessions';
import { defineTool, toolFail, toolOk, type McpModule } from './types';

/**
 * MCP Chat — durable conversation memory.
 *
 * The TUI already shows the current transcript; this MCP is what lets the
 * agent *recall* across sessions, search old work and export it.
 */

const append = defineTool({
  name: 'chat_append',
  title: 'Remember message',
  description: 'Persist a note or message into the current session transcript.',
  params: 'content:string, role?:"user"|"assistant"|"system"|"tool"',
  danger: 'write',
  schema: z.object({
    content: z.string().min(1),
    role: z.enum(['user', 'assistant', 'system', 'tool']).optional(),
  }),
  async run(args, ctx) {
    await appendStoredMessage(ctx.sessionId, { role: args.role ?? 'assistant', content: args.content });
    return toolOk(`✔ stored ${formatBytes(Buffer.byteLength(args.content))} in session ${ctx.sessionId}`);
  },
});

const history = defineTool({
  name: 'chat_history',
  title: 'Session history',
  description: 'Read back the most recent messages of a session (defaults to the current one).',
  params: 'session?:string, limit?:number',
  danger: 'safe',
  schema: z.object({ session: z.string().optional(), limit: z.number().int().min(1).max(500).optional() }),
  async run(args, ctx) {
    const sessionId = args.session ?? ctx.sessionId;
    const messages = await readSession(sessionId, args.limit ?? 40);
    if (messages.length === 0) return toolOk(`(no messages stored for ${sessionId})`);
    return toolOk(messages.map((message) => `[${message.at}] ${message.role}: ${message.content}`).join('\n\n'));
  },
});

const search = defineTool({
  name: 'chat_search',
  title: 'Search memory',
  description: 'Full-text search across every stored session.',
  params: 'query:string, limit?:number',
  danger: 'safe',
  schema: z.object({ query: z.string().min(2), limit: z.number().int().min(1).max(100).optional() }),
  async run(args) {
    const hits = await searchSessions(args.query, args.limit ?? 15);
    if (hits.length === 0) return toolOk(`No stored messages contain "${args.query}".`);
    return toolOk(hits.map((hit) => `${hit.session} · ${hit.role} · ${hit.at}\n  ${hit.text}`).join('\n'));
  },
});

const sessions = defineTool({
  name: 'chat_sessions',
  title: 'List sessions',
  description: 'List saved sessions with message counts and titles.',
  params: '(no arguments)',
  danger: 'safe',
  schema: z.object({}),
  async run() {
    const list = await listSessions();
    if (list.length === 0) return toolOk('No sessions stored yet.');
    return toolOk(
      list
        .slice(0, 30)
        .map((session) => `${session.id} · ${session.messages} msg · ${session.updatedAt}\n  ${session.title}`)
        .join('\n'),
    );
  },
});

const exportSession = defineTool({
  name: 'chat_export',
  title: 'Export session',
  description: 'Export a session as Markdown or JSON into the workspace.',
  params: 'format?:"markdown"|"json", session?:string, file?:string',
  danger: 'write',
  schema: z.object({
    format: z.enum(['markdown', 'json']).optional(),
    session: z.string().optional(),
    file: z.string().optional(),
  }),
  async run(args, ctx) {
    const sessionId = args.session ?? ctx.sessionId;
    const messages = await readSession(sessionId, 2000);
    if (messages.length === 0) return toolFail(`Session ${sessionId} has no messages.`);
    const format = args.format ?? 'markdown';
    const extension = format === 'json' ? 'json' : 'md';
    const target = path.resolve(ctx.workspace, args.file ?? `session-${sessionId}.${extension}`);
    if (!target.startsWith(path.resolve(ctx.workspace))) return toolFail('Output must be inside the workspace.');
    const body = format === 'json' ? JSON.stringify(messages, null, 2) : exportSessionMarkdown(sessionId, messages);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, body, 'utf8');
    return toolOk(`✔ exported ${messages.length} messages → ${path.relative(ctx.workspace, target)}`);
  },
});

const clear = defineTool({
  name: 'chat_clear',
  title: 'Clear session',
  description: 'Erase the stored transcript for a session.',
  params: 'session?:string, confirm:boolean',
  danger: 'dangerous',
  schema: z.object({ session: z.string().optional(), confirm: z.boolean() }),
  async run(args, ctx) {
    if (!args.confirm) return toolFail('Refusing to clear history without confirm=true.');
    const sessionId = args.session ?? ctx.sessionId;
    truncateSession(sessionId);
    return toolOk(`✔ cleared session ${sessionId}`);
  },
});

const stats = defineTool({
  name: 'chat_stats',
  title: 'Memory stats',
  description: 'Count sessions, messages and total stored bytes.',
  params: '(no arguments)',
  danger: 'safe',
  schema: z.object({}),
  async run() {
    const list = await listSessions();
    const messages = list.reduce((total, session) => total + session.messages, 0);
    const bytes = list.reduce((total, session) => total + session.bytes, 0);
    return toolOk(
      `sessions: ${list.length}\nmessages: ${messages}\nstorage : ${formatBytes(bytes)}\nlatest  : ${list[0]?.id ?? '—'}`,
    );
  },
});

export const chatMcp: McpModule = {
  id: 'chat',
  name: 'MCP Chat',
  blurb: 'Persistent transcripts, recall and export.',
  version: '1.0.0',
  tools: [append, history, search, sessions, exportSession, clear, stats],
  async probe() {
    return { status: 'ready', detail: 'jsonl session store online' };
  },
};
