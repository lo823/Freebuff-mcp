import path from 'node:path';
import { z } from 'zod';
import { hasCommand, run } from '../utils/shell';
import { capOutput } from '../utils/text';
import { defineTool, toolFail, toolOk, type McpModule, type ToolResult } from './types';

/**
 * MCP GitHub — REST API tools.
 *
 * Token comes from GITHUB_TOKEN or GH_TOKEN. Without one you still get public
 * reads at the anonymous rate limit (60 req/h), which is plenty for browsing.
 */

const API = 'https://api.github.com';

function token(): string | undefined {
  return process.env.GITHUB_TOKEN || process.env.GH_TOKEN || process.env.GITHUB_PAT;
}

function headers(): Record<string, string> {
  const base: Record<string, string> = {
    accept: 'application/vnd.github+json',
    'user-agent': 'AI-FREEBUFF-MCP-Termux',
    'x-github-api-version': '2022-11-28',
  };
  const key = token();
  if (key) base.authorization = `Bearer ${key}`;
  return base;
}

async function api<T = unknown>(
  endpoint: string,
  options: { method?: string; body?: unknown } = {},
): Promise<{ ok: boolean; data?: T; error?: string; raw?: string }> {
  try {
    const response = await fetch(`${API}${endpoint}`, {
      method: options.method ?? 'GET',
      headers: { ...headers(), ...(options.body ? { 'content-type': 'application/json' } : {}) },
      body: options.body ? JSON.stringify(options.body) : undefined,
    });
    const text = await response.text();
    if (!response.ok) {
      let message = text.slice(0, 500);
      try {
        const parsed = JSON.parse(text) as { message?: string };
        if (parsed.message) message = parsed.message;
      } catch {
        /* keep raw */
      }
      const remaining = response.headers.get('x-ratelimit-remaining');
      const hint =
        response.status === 403 && remaining === '0'
          ? '\nRate limit exhausted. Set GITHUB_TOKEN to raise it to 5000 req/h.'
          : response.status === 401
            ? '\nToken rejected. Check GITHUB_TOKEN.'
            : response.status === 404
              ? '\nNot found — check the owner/repo spelling or your access.'
              : '';
      return { ok: false, error: `HTTP ${response.status}: ${message}${hint}`, raw: text };
    }
    return { ok: true, data: text ? (JSON.parse(text) as T) : (undefined as T) };
  } catch (error) {
    return { ok: false, error: `Network error: ${(error as Error).message}` };
  }
}

interface RepoPayload {
  full_name: string;
  description: string | null;
  html_url: string;
  stargazers_count: number;
  forks_count: number;
  open_issues_count: number;
  language: string | null;
  license: { spdx_id?: string } | null;
  default_branch: string;
  updated_at: string;
  topics?: string[];
}

function repoLabel(value: string): string {
  return value.replace(/^https?:\/\/github\.com\//, '').replace(/\.git$/, '').replace(/\/$/, '');
}

const user = defineTool({
  name: 'github_user',
  title: 'GitHub identity',
  description: 'Show the authenticated user (or report that no token is set).',
  params: '(no arguments)',
  danger: 'safe',
  schema: z.object({}),
  async run() {
    if (!token()) return toolFail('No GITHUB_TOKEN / GH_TOKEN set. Public read tools still work unauthenticated.');
    const result = await api<{ login: string; name?: string; public_repos: number; html_url: string }>('/user');
    if (!result.ok) return toolFail(result.error ?? 'failed');
    return toolOk(`login : ${result.data?.login}\nname  : ${result.data?.name ?? '—'}\nrepos : ${result.data?.public_repos}\nurl   : ${result.data?.html_url}`);
  },
});

const repo = defineTool({
  name: 'github_repo',
  title: 'Repository info',
  description: 'Summary of a repository: stars, language, license, activity.',
  params: 'repo:string ("owner/name")',
  danger: 'safe',
  schema: z.object({ repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/) }),
  async run(args) {
    const result = await api<RepoPayload>(`/repos/${repoLabel(args.repo)}`);
    if (!result.ok || !result.data) return toolFail(result.error ?? 'not found');
    const data = result.data;
    return toolOk(
      [
        `repo      : ${data.full_name}`,
        `description: ${data.description ?? '—'}`,
        `stars     : ${data.stargazers_count}  forks: ${data.forks_count}  issues: ${data.open_issues_count}`,
        `language  : ${data.language ?? '—'}  license: ${data.license?.spdx_id ?? '—'}`,
        `branch    : ${data.default_branch}  updated: ${data.updated_at}`,
        data.topics?.length ? `topics    : ${data.topics.join(', ')}` : '',
        `url       : ${data.html_url}`,
      ]
        .filter(Boolean)
        .join('\n'),
    );
  },
});

const issues = defineTool({
  name: 'github_issues',
  title: 'List issues',
  description: 'List issues for a repository (PRs excluded).',
  params: 'repo:string, state?:"open"|"closed"|"all", limit?:number',
  danger: 'safe',
  schema: z.object({
    repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/),
    state: z.enum(['open', 'closed', 'all']).optional(),
    limit: z.number().int().min(1).max(50).optional(),
  }),
  async run(args) {
    const limit = args.limit ?? 15;
    const result = await api<Array<{ number: number; title: string; user?: { login: string }; labels: Array<{ name: string }>; pull_request?: unknown }>>(
      `/repos/${repoLabel(args.repo)}/issues?state=${args.state ?? 'open'}&per_page=${limit}`,
    );
    if (!result.ok || !result.data) return toolFail(result.error ?? 'failed');
    const rows = result.data
      .filter((issue) => !issue.pull_request)
      .map((issue) => `#${issue.number} [${issue.labels.map((label) => label.name).join(',') || 'no-label'}] ${issue.title} — @${issue.user?.login ?? '?'}`);
    return toolOk(rows.join('\n') || '(no issues)');
  },
});

const issueCreate = defineTool({
  name: 'github_issue_create',
  title: 'Create issue',
  description: 'Open a new issue on a repository.',
  params: 'repo:string, title:string, body?:string, labels?:string[]',
  danger: 'dangerous',
  schema: z.object({
    repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/),
    title: z.string().min(3).max(200),
    body: z.string().optional(),
    labels: z.array(z.string()).optional(),
  }),
  async run(args) {
    if (!token()) return toolFail('Creating issues requires GITHUB_TOKEN.');
    const result = await api<{ number: number; html_url: string }>(`/repos/${repoLabel(args.repo)}/issues`, {
      method: 'POST',
      body: { title: args.title, body: args.body ?? '', labels: args.labels ?? [] },
    });
    if (!result.ok) return toolFail(result.error ?? 'failed');
    return toolOk(`✔ created issue #${result.data?.number}\n${result.data?.html_url}`);
  },
});

const pullRequests = defineTool({
  name: 'github_prs',
  title: 'List pull requests',
  description: 'List pull requests for a repository.',
  params: 'repo:string, state?:"open"|"closed"|"all", limit?:number',
  danger: 'safe',
  schema: z.object({
    repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/),
    state: z.enum(['open', 'closed', 'all']).optional(),
    limit: z.number().int().min(1).max(50).optional(),
  }),
  async run(args) {
    const result = await api<Array<{ number: number; title: string; user?: { login: string }; draft?: boolean; html_url: string }>>(
      `/repos/${repoLabel(args.repo)}/pulls?state=${args.state ?? 'open'}&per_page=${args.limit ?? 15}`,
    );
    if (!result.ok || !result.data) return toolFail(result.error ?? 'failed');
    return toolOk(
      result.data
        .map((pr) => `#${pr.number}${pr.draft ? ' (draft)' : ''} ${pr.title} — @${pr.user?.login ?? '?'}\n  ${pr.html_url}`)
        .join('\n') || '(no pull requests)',
    );
  },
});

const search = defineTool({
  name: 'github_search',
  title: 'Search GitHub',
  description: 'Search repositories, code or issues.',
  params: 'query:string, type?:"repositories"|"code"|"issues", limit?:number',
  danger: 'safe',
  schema: z.object({
    query: z.string().min(2),
    type: z.enum(['repositories', 'code', 'issues']).optional(),
    limit: z.number().int().min(1).max(30).optional(),
  }),
  async run(args) {
    const type = args.type ?? 'repositories';
    const result = await api<{ items?: Array<Record<string, any>>; total_count?: number }>(
      `/search/${type}?q=${encodeURIComponent(args.query)}&per_page=${args.limit ?? 10}`,
    );
    if (!result.ok || !result.data) return toolFail(result.error ?? 'failed');
    const items = result.data.items ?? [];
    if (!items.length) return toolOk(`No results for "${args.query}".`);
    const rows = items.map((item) => {
      if (type === 'repositories') return `${item.full_name} ★${item.stargazers_count} — ${item.description ?? ''}`;
      if (type === 'issues') return `#${item.number} ${item.title} (${item.html_url})`;
      return `${item.repository?.full_name ?? ''}/${item.path} — ${item.html_url}`;
    });
    return toolOk(`${result.data.total_count ?? items.length} result(s)\n${rows.join('\n')}`);
  },
});

const releases = defineTool({
  name: 'github_releases',
  title: 'List releases',
  description: 'List published releases with asset names.',
  params: 'repo:string, limit?:number',
  danger: 'safe',
  schema: z.object({ repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/), limit: z.number().int().min(1).max(20).optional() }),
  async run(args) {
    const result = await api<Array<{ tag_name: string; name: string; published_at: string; assets: Array<{ name: string; size: number; browser_download_url: string }> }>>(
      `/repos/${repoLabel(args.repo)}/releases?per_page=${args.limit ?? 5}`,
    );
    if (!result.ok || !result.data) return toolFail(result.error ?? 'failed');
    return toolOk(
      result.data
        .map(
          (release) =>
            `${release.tag_name} · ${release.name} (${release.published_at?.slice(0, 10)})\n` +
            (release.assets.map((asset) => `  · ${asset.name} (${Math.round(asset.size / 1024)} KB)`).join('\n') || '  (no assets)'),
        )
        .join('\n\n') || '(no releases)',
    );
  },
});

const fileContents = defineTool({
  name: 'github_file',
  title: 'Read repo file',
  description: 'Fetch a text file from a repository.',
  params: 'repo:string, path:string, ref?:string',
  danger: 'safe',
  schema: z.object({ repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/), path: z.string().min(1), ref: z.string().optional() }),
  async run(args) {
    const suffix = args.ref ? `?ref=${encodeURIComponent(args.ref)}` : '';
    const result = await api<{ content?: string; encoding?: string; size?: number; html_url?: string }>(
      `/repos/${repoLabel(args.repo)}/contents/${args.path}${suffix}`,
    );
    if (!result.ok || !result.data) return toolFail(result.error ?? 'failed');
    if (!result.data.content) return toolFail('Not a file, or too large for the contents API.');
    const decoded = Buffer.from(result.data.content, (result.data.encoding as BufferEncoding) || 'base64').toString('utf8');
    return toolOk(`# ${args.repo}/${args.path}\n${capOutput(decoded, 12_000)}`);
  },
});

const clone = defineTool({
  name: 'github_clone',
  title: 'Clone repository',
  description: 'Shallow-clone a repository into the workspace.',
  params: 'repo:string, dir?:string, depth?:number',
  danger: 'write',
  schema: z.object({
    repo: z.string().regex(/^([\w.-]+\/[\w.-]+|https?:\/\/\S+)$/),
    dir: z.string().optional(),
    depth: z.number().int().min(1).max(100).optional(),
  }),
  async run(args, ctx) {
    if (!(await hasCommand('git'))) return toolFail('git is not installed. Fix: pkg install git');
    const slug = repoLabel(args.repo).split('/').slice(-1)[0] || 'repo';
    const target = path.resolve(ctx.workspace, args.dir ?? slug);
    if (!target.startsWith(path.resolve(ctx.workspace))) return toolFail('Target must be inside the workspace.');
    const url = args.repo.startsWith('http') ? args.repo : `https://github.com/${repoLabel(args.repo)}.git`;
    const result = await run('git', ['clone', '--depth', String(args.depth ?? 1), url, target], { timeoutMs: 180_000 });
    if (result.code !== 0) return toolFail(`git clone failed\n${(result.stderr || result.stdout).slice(0, 1200)}`);
    return toolOk(`✔ cloned ${repoLabel(args.repo)} → ${path.relative(ctx.workspace, target)}`);
  },
});

const gist = defineTool({
  name: 'github_gist_create',
  title: 'Create gist',
  description: 'Publish a gist (secret by default).',
  params: 'filename:string, content:string, description?:string, public?:boolean',
  danger: 'dangerous',
  schema: z.object({
    filename: z.string().min(1),
    content: z.string(),
    description: z.string().optional(),
    public: z.boolean().optional(),
  }),
  async run(args): Promise<ToolResult> {
    if (!token()) return toolFail('Creating gists requires GITHUB_TOKEN.');
    const result = await api<{ html_url: string; id: string }>('/gists', {
      method: 'POST',
      body: {
        description: args.description ?? 'AI-FREEBUFF MCP snippet',
        public: args.public ?? false,
        files: { [args.filename]: { content: args.content } },
      },
    });
    if (!result.ok) return toolFail(result.error ?? 'failed');
    return toolOk(`✔ gist created: ${result.data?.html_url}`);
  },
});

export const githubMcp: McpModule = {
  id: 'github',
  name: 'MCP GitHub',
  blurb: 'Repos, issues, PRs, search, releases, gists, clone.',
  version: '1.0.0',
  tools: [user, repo, issues, issueCreate, pullRequests, search, releases, fileContents, clone, gist],
  async probe() {
    if (!token()) return { status: 'degraded', detail: 'no token — anonymous 60 req/h' };
    const result = await api('/rate_limit');
    return result.ok
      ? { status: 'ready', detail: 'token accepted' }
      : { status: 'degraded', detail: result.error?.slice(0, 120) ?? 'token rejected' };
  },
};
