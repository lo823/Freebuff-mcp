import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { capOutput, formatBytes } from '../utils/text';
import { defineTool, toolFail, toolOk, type McpModule, type ToolResult } from './types';

/**
 * MCP File — sandboxed filesystem access.
 *
 * Every path resolves inside the configured workspace. Symlinks are resolved
 * before the containment check so a link cannot be used to escape the sandbox.
 */

const MAX_READ_BYTES = 2_000_000;
const IGNORED_DIRS = new Set(['.git', 'node_modules', '.cache', 'dist', '.venv', '__pycache__']);

async function resolveSafePath(root: string, target: string): Promise<string> {
  const rootReal = await fs.realpath(root).catch(() => path.resolve(root));
  const candidate = path.resolve(rootReal, target);
  const relative = path.relative(rootReal, candidate);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(
      `Refusing to access "${target}" — outside workspace ${rootReal}. ` +
        'Set AI_FREEBUFF_WORKSPACE to a parent directory if this is intended.',
    );
  }

  // Resolve symlinks (for paths that already exist) and re-check.
  try {
    const real = await fs.realpath(candidate);
    const relReal = path.relative(rootReal, real);
    if (relReal === '..' || relReal.startsWith(`..${path.sep}`) || path.isAbsolute(relReal)) {
      throw new Error(`Refusing to follow symlink outside workspace: ${target}`);
    }
    return real;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Refusing')) throw error;
    return candidate; // Path does not exist yet: safe parent check already passed.
  }
}

function globToRegExp(pattern: string): RegExp {
  const normalized = pattern.replace(/\\/g, '/').replace(/^\.\//, '');
  let source = '';
  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index] as string;
    const next = normalized[index + 1];
    if (char === '*' && next === '*') {
      const afterSlash = normalized[index + 2] === '/';
      source += afterSlash ? '(?:.*/)?' : '.*';
      index += afterSlash ? 2 : 1;
    } else if (char === '*') {
      source += '[^/]*';
    } else if (char === '?') {
      source += '[^/]';
    } else if ('\\^$+.()|{}[]'.includes(char)) {
      source += `\\${char}`;
    } else {
      source += char;
    }
  }
  return new RegExp(`^${source}$`, 'i');
}

async function walk(root: string, dir: string, depth: number, files: string[]): Promise<void> {
  if (depth < 0) return;
  let entries: import('node:fs').Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.') && entry.name !== '.env.example') continue;
    const full = path.join(dir, entry.name);
    const relative = path.relative(root, full).replace(/\\/g, '/');
    if (entry.isDirectory()) {
      if (IGNORED_DIRS.has(entry.name)) continue;
      files.push(`${relative}/`);
      await walk(root, full, depth - 1, files);
    } else {
      files.push(relative);
    }
  }
}

function lineNumbers(content: string, offset: number, limit: number): { text: string; total: number } {
  const lines = content.split('\n');
  const total = lines.length;
  const start = Math.max(0, offset - 1);
  const slice = lines.slice(start, start + limit);
  const width = String(start + slice.length).length;
  const text = slice
    .map((line, index) => `${String(start + index + 1).padStart(width, ' ')} │ ${line}`)
    .join('\n');
  return { text, total };
}

const fileRead = defineTool({
  name: 'file_read',
  title: 'Read file',
  description: 'Read a UTF-8 text file inside the workspace with line numbers.',
  params: 'path:string, offset?:number, limit?:number',
  danger: 'safe',
  schema: z.object({
    path: z.string().min(1),
    offset: z.number().int().min(1).optional(),
    limit: z.number().int().min(1).max(2000).optional(),
  }),
  async run(args, ctx): Promise<ToolResult> {
    const target = await resolveSafePath(ctx.workspace, args.path);
    const stat = await fs.stat(target);
    if (stat.isDirectory()) {
      const entries = await fs.readdir(target, { withFileTypes: true });
      return toolOk(
        entries
          .slice(0, 200)
          .map((entry) => `${entry.isDirectory() ? '[dir] ' : '      '}${entry.name}`)
          .join('\n'),
      );
    }
    if (stat.size > MAX_READ_BYTES) {
      return toolFail(`File is ${formatBytes(stat.size)} — larger than the ${formatBytes(MAX_READ_BYTES)} read limit.`);
    }
    const raw = await fs.readFile(target, 'utf8');
    if (raw.includes('\u0000')) return toolFail('Binary file detected. Use rea_scan for binary analysis.');
    const { text, total } = lineNumbers(raw, args.offset ?? 1, args.limit ?? 400);
    return toolOk(`# ${args.path} (${total} lines, ${formatBytes(stat.size)})\n${text}`);
  },
});

const fileWrite = defineTool({
  name: 'file_write',
  title: 'Write file',
  description: 'Create or overwrite a file inside the workspace.',
  params: 'path:string, content:string, createDirs?:boolean',
  danger: 'write',
  schema: z.object({
    path: z.string().min(1),
    content: z.string(),
    createDirs: z.boolean().optional(),
  }),
  async run(args, ctx): Promise<ToolResult> {
    const target = await resolveSafePath(ctx.workspace, args.path);
    if (args.createDirs !== false) await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, args.content, 'utf8');
    const relative = path.relative(ctx.workspace, target);
    return toolOk(`✔ wrote ${formatBytes(Buffer.byteLength(args.content))} to ${relative}`);
  },
});

const fileAppend = defineTool({
  name: 'file_append',
  title: 'Append file',
  description: 'Append text to a file (creates it when missing).',
  params: 'path:string, content:string',
  danger: 'write',
  schema: z.object({ path: z.string().min(1), content: z.string() }),
  async run(args, ctx): Promise<ToolResult> {
    const target = await resolveSafePath(ctx.workspace, args.path);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.appendFile(target, args.content, 'utf8');
    return toolOk(`✔ appended ${formatBytes(Buffer.byteLength(args.content))} to ${args.path}`);
  },
});

const fileList = defineTool({
  name: 'file_list',
  title: 'List directory',
  description: 'List a directory, optionally recursing with a depth limit.',
  params: 'path?:string, depth?:number',
  danger: 'safe',
  schema: z.object({ path: z.string().optional(), depth: z.number().int().min(1).max(6).optional() }),
  async run(args, ctx): Promise<ToolResult> {
    const target = await resolveSafePath(ctx.workspace, args.path ?? '.');
    const depth = args.depth ?? 1;
    if (depth === 1) {
      const entries = await fs.readdir(target, { withFileTypes: true });
      const rows = await Promise.all(
        entries
          .filter((entry) => !IGNORED_DIRS.has(entry.name) || entry.name === '.env.example')
          .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
          .map(async (entry) => {
            const full = path.join(target, entry.name);
            if (entry.isDirectory()) return `▸ ${entry.name}/`;
            const stat = await fs.stat(full).catch(() => null);
            return `  ${entry.name}${stat ? ` (${formatBytes(stat.size)})` : ''}`;
          }),
      );
      return toolOk(rows.join('\n') || '(empty directory)');
    }
    const files: string[] = [];
    await walk(target, target, depth, files);
    return toolOk(capOutput(files.slice(0, 800).join('\n') || '(empty directory)', 12_000));
  },
});

const fileGlob = defineTool({
  name: 'file_glob',
  title: 'Glob files',
  description: 'Find files by glob pattern, e.g. "src/**/*.tsx" or "**/*.gd".',
  params: 'pattern:string, cwd?:string',
  danger: 'safe',
  schema: z.object({ pattern: z.string().min(1), cwd: z.string().optional() }),
  async run(args, ctx): Promise<ToolResult> {
    const base = await resolveSafePath(ctx.workspace, args.cwd ?? '.');
    const regex = globToRegExp(args.pattern);
    const files: string[] = [];
    await walk(base, base, 8, files);
    const matches = files.filter((file) => regex.test(file.endsWith('/') ? file.slice(0, -1) : file));
    return toolOk(
      matches.length ? `${matches.length} match(es):\n${capOutput(matches.slice(0, 400).join('\n'), 10_000)}` : 'No files matched.',
    );
  },
});

const fileSearch = defineTool({
  name: 'file_search',
  title: 'Search file contents',
  description: 'Grep the workspace for a literal string or regular expression.',
  params: 'pattern:string, path?:string, ignoreCase?:boolean, maxResults?:number',
  danger: 'safe',
  schema: z.object({
    pattern: z.string().min(1),
    path: z.string().optional(),
    ignoreCase: z.boolean().optional(),
    maxResults: z.number().int().min(1).max(500).optional(),
  }),
  async run(args, ctx): Promise<ToolResult> {
    const base = await resolveSafePath(ctx.workspace, args.path ?? '.');
    let regex: RegExp;
    try {
      regex = new RegExp(args.pattern, args.ignoreCase === false ? 'g' : 'gi');
    } catch {
      regex = new RegExp(args.pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), args.ignoreCase === false ? 'g' : 'gi');
    }
    const max = args.maxResults ?? 80;
    const hits: string[] = [];
    const files: string[] = [];
    const stat = await fs.stat(base);
    if (stat.isFile()) files.push('');
    else await walk(base, base, 8, files);

    for (const relativeFile of files) {
      if (hits.length >= max) break;
      if (relativeFile.endsWith('/')) continue;
      const full = path.join(base, relativeFile);
      let content: string;
      try {
        const fileStat = await fs.stat(full);
        if (fileStat.size > 1_500_000) continue;
        content = await fs.readFile(full, 'utf8');
      } catch {
        continue;
      }
      if (content.includes('\u0000')) continue;
      const lines = content.split('\n');
      for (let index = 0; index < lines.length && hits.length < max; index += 1) {
        const line = lines[index] as string;
        regex.lastIndex = 0;
        if (!regex.test(line)) continue;
        const label = relativeFile || path.basename(full);
        hits.push(`${label}:${index + 1}: ${line.trim().slice(0, 240)}`);
      }
    }
    return toolOk(hits.length ? hits.join('\n') : `No matches for /${args.pattern}/`);
  },
});

const fileMove = defineTool({
  name: 'file_move',
  title: 'Move / rename',
  description: 'Move or rename a file or directory inside the workspace.',
  params: 'from:string, to:string',
  danger: 'write',
  schema: z.object({ from: z.string().min(1), to: z.string().min(1) }),
  async run(args, ctx): Promise<ToolResult> {
    const source = await resolveSafePath(ctx.workspace, args.from);
    const destination = await resolveSafePath(ctx.workspace, args.to);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.rename(source, destination);
    return toolOk(`✔ moved ${args.from} → ${args.to}`);
  },
});

const fileCopy = defineTool({
  name: 'file_copy',
  title: 'Copy',
  description: 'Copy a file or directory inside the workspace.',
  params: 'from:string, to:string',
  danger: 'write',
  schema: z.object({ from: z.string().min(1), to: z.string().min(1) }),
  async run(args, ctx): Promise<ToolResult> {
    const source = await resolveSafePath(ctx.workspace, args.from);
    const destination = await resolveSafePath(ctx.workspace, args.to);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.cp(source, destination, { recursive: true, force: true });
    return toolOk(`✔ copied ${args.from} → ${args.to}`);
  },
});

const fileDelete = defineTool({
  name: 'file_delete',
  title: 'Delete',
  description: 'Delete a file or directory. Requires explicit confirmation in the call.',
  params: 'path:string, recursive?:boolean, confirm:boolean',
  danger: 'dangerous',
  schema: z.object({
    path: z.string().min(1),
    recursive: z.boolean().optional(),
    confirm: z.boolean(),
  }),
  async run(args, ctx): Promise<ToolResult> {
    if (!args.confirm) return toolFail('Refusing to delete without confirm=true.');
    const target = await resolveSafePath(ctx.workspace, args.path);
    if (target === path.resolve(ctx.workspace)) return toolFail('Refusing to delete the workspace root.');
    await fs.rm(target, { recursive: args.recursive ?? false, force: false });
    return toolOk(`✔ deleted ${args.path}`);
  },
});

const fileStat = defineTool({
  name: 'file_stat',
  title: 'File info',
  description: 'Show type, size and timestamps for a path.',
  params: 'path:string',
  danger: 'safe',
  schema: z.object({ path: z.string().min(1) }),
  async run(args, ctx): Promise<ToolResult> {
    const target = await resolveSafePath(ctx.workspace, args.path);
    const stat = await fs.lstat(target);
    return toolOk(
      [
        `path      : ${path.relative(ctx.workspace, target) || '.'}`,
        `type      : ${stat.isDirectory() ? 'directory' : stat.isSymbolicLink() ? 'symlink' : 'file'}`,
        `size      : ${formatBytes(stat.size)}`,
        `modified  : ${stat.mtime.toISOString()}`,
        `created   : ${stat.birthtime.toISOString()}`,
      ].join('\n'),
    );
  },
});

const filePatch = defineTool({
  name: 'file_patch',
  title: 'Patch text',
  description: 'Replace an exact snippet inside a file (small, reviewable edits).',
  params: 'path:string, find:string, replace:string, all?:boolean',
  danger: 'write',
  schema: z.object({
    path: z.string().min(1),
    find: z.string().min(1),
    replace: z.string(),
    all: z.boolean().optional(),
  }),
  async run(args, ctx): Promise<ToolResult> {
    const target = await resolveSafePath(ctx.workspace, args.path);
    const content = await fs.readFile(target, 'utf8');
    const occurrences = content.split(args.find).length - 1;
    if (occurrences === 0) return toolFail(`Snippet not found in ${args.path}.`);
    if (occurrences > 1 && args.all !== true) {
      return toolFail(`Snippet appears ${occurrences} times. Pass all=true to replace every occurrence.`);
    }
    const updated = args.all ? content.split(args.find).join(args.replace) : content.replace(args.find, args.replace);
    await fs.writeFile(target, updated, 'utf8');
    return toolOk(`✔ patched ${args.path} (${args.all ? occurrences : 1} replacement(s))`);
  },
});

const dirCreate = defineTool({
  name: 'dir_create',
  title: 'Create directory',
  description: 'Create a directory (parents included) inside the workspace.',
  params: 'path:string',
  danger: 'write',
  schema: z.object({ path: z.string().min(1) }),
  async run(args, ctx): Promise<ToolResult> {
    const target = await resolveSafePath(ctx.workspace, args.path);
    await fs.mkdir(target, { recursive: true });
    return toolOk(`✔ directory ready: ${args.path}`);
  },
});

export const fileMcp: McpModule = {
  id: 'file',
  name: 'MCP File',
  blurb: 'Sandboxed read/write/search across the workspace.',
  version: '1.0.0',
  tools: [
    fileRead,
    fileWrite,
    fileAppend,
    fileList,
    fileGlob,
    fileSearch,
    fileMove,
    fileCopy,
    fileDelete,
    fileStat,
    filePatch,
    dirCreate,
  ],
  async probe() {
    try {
      await fs.access(process.env.AI_FREEBUFF_WORKSPACE || process.cwd());
      return { status: 'ready', detail: 'workspace reachable' };
    } catch {
      return { status: 'degraded', detail: 'workspace not created yet' };
    }
  },
};
