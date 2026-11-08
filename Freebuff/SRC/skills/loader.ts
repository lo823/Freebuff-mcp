import fs from 'node:fs/promises';
import path from 'node:path';
import { log } from '../utils/logger';
import { ensureAppDirs, paths } from '../utils/paths';
import { hasCommand, run } from '../utils/shell';
import { formatBytes } from '../utils/text';
import { resolveSkillDefinition, type SkillDefinition } from './registry';

/**
 * Skill loader.
 *
 * Skills are cloned into `~/.ai-freebuff/skills/<slug>` so they survive
 * upgrades and can be inspected/edited by hand. Installation is idempotent and
 * works with either `git` or a plain zip download.
 */

export interface InstalledSkill {
  slug: string;
  name: string;
  path: string;
  repo?: string;
  url?: string;
  description?: string;
  installedAt?: string;
  bytes: number;
  hasInstructions: boolean;
  instructionsFile?: string;
  source: 'builtin' | 'custom';
}

export interface InstallOptions {
  force?: boolean;
  onProgress?: (message: string) => void;
}

const META_FILE = '.freebuff-skill.json';
const SAFE_SLUG = /^[a-z0-9][a-z0-9._-]{0,63}$/;

function skillPath(slug: string): string {
  if (!SAFE_SLUG.test(slug)) throw new Error(`Unsafe skill slug: ${slug}`);
  return path.join(paths.skills, slug);
}

async function dirSize(dir: string): Promise<number> {
  let total = 0;
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) total += await dirSize(full);
    else total += (await fs.stat(full).catch(() => ({ size: 0 }))).size;
  }
  return total;
}

async function findInstructions(dir: string, entryFiles: string[]): Promise<string | undefined> {
  for (const file of entryFiles) {
    const full = path.join(dir, file);
    try {
      await fs.access(full);
      return full;
    } catch {
      /* next */
    }
  }
  // Nested layouts (e.g. openai/skills keeps skills in subdirectories).
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    for (const file of entryFiles) {
      const full = path.join(dir, entry.name, file);
      try {
        await fs.access(full);
        return full;
      } catch {
        /* keep looking */
      }
    }
  }
  return undefined;
}

async function describe(slug: string, definition?: SkillDefinition): Promise<InstalledSkill> {
  const dir = skillPath(slug);
  const stat = await fs.stat(dir);
  const meta = JSON.parse(await fs.readFile(path.join(dir, META_FILE), 'utf8').catch(() => '{}')) as {
    repo?: string;
    url?: string;
    description?: string;
    installedAt?: string;
    source?: 'builtin' | 'custom';
  };
  const instructions = await findInstructions(dir, definition?.entryFiles ?? ['SKILL.md', 'README.md']);
  return {
    slug,
    name: definition?.name ?? slug,
    path: dir,
    repo: meta.repo,
    url: meta.url,
    description: meta.description,
    installedAt: meta.installedAt ?? stat.mtime.toISOString(),
    bytes: await dirSize(dir),
    hasInstructions: Boolean(instructions),
    instructionsFile: instructions ? path.relative(dir, instructions) : undefined,
    source: meta.source ?? 'builtin',
  };
}

export async function listInstalledSkills(): Promise<InstalledSkill[]> {
  ensureAppDirs();
  const entries = await fs.readdir(paths.skills, { withFileTypes: true }).catch(() => []);
  const skills: InstalledSkill[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !SAFE_SLUG.test(entry.name)) continue;
    try {
      skills.push(await describe(entry.name));
    } catch {
      /* partial install */
    }
  }
  return skills.sort((a, b) => a.slug.localeCompare(b.slug));
}

async function downloadZip(definition: SkillDefinition, target: string, onProgress?: (message: string) => void): Promise<void> {
  const archive = path.join(paths.cache, `${definition.slug}.zip`);
  const url = `${definition.url}/archive/refs/heads/${definition.branch}.zip`;
  const downloader = (await hasCommand('curl')) ? 'curl' : (await hasCommand('wget')) ? 'wget' : null;
  if (!downloader) throw new Error('Neither git nor curl/wget is available. Run: pkg install git curl');

  onProgress?.(`downloading ${definition.slug}.zip`);
  const download =
    downloader === 'curl'
      ? await run('curl', ['-fsSL', url, '-o', archive], { timeoutMs: 180_000 })
      : await run('wget', ['-q', '-O', archive, url], { timeoutMs: 180_000 });
  if (download.code !== 0) throw new Error(`Download failed: ${(download.stderr || download.stdout).slice(0, 400)}`);

  const unzip = (await hasCommand('unzip')) ? 'unzip' : (await hasCommand('busybox')) ? 'busybox' : null;
  if (!unzip) throw new Error('unzip is not available. Run: pkg install unzip');
  const staging = path.join(paths.cache, `${definition.slug}-extract`);
  await fs.rm(staging, { recursive: true, force: true });
  await fs.mkdir(staging, { recursive: true });

  onProgress?.('extracting');
  const extract =
    unzip === 'unzip'
      ? await run('unzip', ['-q', '-o', archive, '-d', staging], { timeoutMs: 120_000 })
      : await run('busybox', ['unzip', '-q', '-o', archive, '-d', staging], { timeoutMs: 120_000 });
  if (extract.code !== 0) throw new Error(`Extraction failed: ${extract.stderr.slice(0, 400)}`);

  const extracted = await fs.readdir(staging, { withFileTypes: true });
  const root = extracted.find((entry) => entry.isDirectory());
  if (!root) throw new Error('Unexpected archive layout.');
  await fs.rename(path.join(staging, root.name), target);
  await fs.rm(staging, { recursive: true, force: true });
  await fs.rm(archive, { force: true });
}

export async function installSkill(input: string, options: InstallOptions = {}): Promise<InstalledSkill> {
  ensureAppDirs();
  const definition = resolveSkillDefinition(input);
  const target = skillPath(definition.slug);
  const onProgress = options.onProgress ?? (() => undefined);

  const exists = await fs
    .stat(target)
    .then(() => true)
    .catch(() => false);

  if (exists && !options.force) {
    onProgress(`${definition.slug} already installed`);
    return describe(definition.slug, definition);
  }
  if (exists && options.force) {
    onProgress(`replacing ${definition.slug}`);
    await fs.rm(target, { recursive: true, force: true });
  }

  await fs.mkdir(paths.skills, { recursive: true });

  if (await hasCommand('git')) {
    onProgress(`cloning ${definition.repo}`);
    let clone = await run('git', ['clone', '--depth', '1', '--branch', definition.branch, definition.url, target], {
      timeoutMs: 240_000,
    });
    if (clone.code !== 0) {
      // Branches are frequently `master` on older repos.
      await fs.rm(target, { recursive: true, force: true });
      clone = await run('git', ['clone', '--depth', '1', definition.url, target], { timeoutMs: 240_000 });
    }
    if (clone.code !== 0) {
      await fs.rm(target, { recursive: true, force: true });
      onProgress('git clone failed — trying archive download');
      await downloadZip(definition, target, onProgress);
    }
  } else {
    onProgress('git not found — using archive download');
    await downloadZip(definition, target, onProgress);
  }

  const isBuiltin = definition.tags.includes('custom') === false;
  await fs.writeFile(
    path.join(target, META_FILE),
    `${JSON.stringify(
      {
        slug: definition.slug,
        name: definition.name,
        repo: definition.repo,
        url: definition.url,
        description: definition.description,
        source: isBuiltin ? 'builtin' : 'custom',
        installedAt: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
    'utf8',
  );

  const installed = await describe(definition.slug, definition);
  log.info('skill installed', { slug: installed.slug, repo: definition.repo, bytes: installed.bytes });
  onProgress(`installed ${installed.slug} (${formatBytes(installed.bytes)})`);
  return installed;
}

export async function removeSkill(slug: string): Promise<void> {
  if (!SAFE_SLUG.test(slug)) throw new Error(`Unsafe skill slug: ${slug}`);
  await fs.rm(skillPath(slug), { recursive: true, force: true });
  log.info('skill removed', { slug });
}

/** Read a skill's instruction file, capped so the prompt stays affordable. */
export async function readSkillInstructions(slug: string, maxChars = 6000): Promise<string> {
  const dir = skillPath(slug);
  const instructions = await findInstructions(dir, ['SKILL.md', 'skill.md', 'README.md']);
  if (!instructions) return '';
  const raw = await fs.readFile(instructions, 'utf8').catch(() => '');
  if (!raw) return '';
  const trimmed = raw.replace(/^---[\s\S]*?---\s*/, '').trim();
  return trimmed.length > maxChars ? `${trimmed.slice(0, maxChars)}\n… (truncated)` : trimmed;
}

/** Compose the system-prompt block for the active skills. */
export async function buildSkillContext(slugs: string[], budgetChars = 7000): Promise<string> {
  if (slugs.length === 0) return '';
  const blocks: string[] = [];
  let used = 0;
  for (const slug of slugs) {
    const instructions = await readSkillInstructions(slug, Math.max(1200, Math.floor(budgetChars / slugs.length)));
    if (!instructions) continue;
    if (used + instructions.length > budgetChars) break;
    used += instructions.length;
    blocks.push(`### Skill: ${slug}\n${instructions}`);
  }
  if (blocks.length === 0) return '';
  return [
    'The following skills are ACTIVE. Follow their guidance unless the user explicitly overrides it.',
    '',
    ...blocks,
  ].join('\n');
}
