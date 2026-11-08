import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import type { McpRegistry } from '../mcp/registry';
import { defineTool, type ToolDef, type ToolResult, toolFail, toolOk } from '../mcp/types';
import { installSkill, listInstalledSkills } from '../skills/loader';
import { BUILTIN_SKILLS, resolveSkillDefinition } from '../skills/registry';
import type { AppConfig } from '../utils/config';
import { describeConfig, loadConfig, saveConfig } from '../utils/config';
import { isTermux, paths, prettyPath } from '../utils/paths';
import { hasCommand, run, runBash } from '../utils/shell';
import { capOutput, formatBytes } from '../utils/text';
import type { ModelRouter } from './model-router';

/**
 * Built-in tools.
 *
 * These are agent capabilities rather than MCP servers: environment reporting,
 * skill installation and MCP installation. They are the "meta" layer that lets
 * the user extend the agent by talking to it.
 */

export interface ToolkitOptions {
  registry: McpRegistry;
  router: ModelRouter;
  sessionId: string;
  getConfig: () => AppConfig;
  setConfig: (config: AppConfig) => void;
  log: (message: string) => void;
}

function sanitizeSlug(input: string): string {
  return input
    .toLowerCase()
    .replace(/^https?:\/\/github\.com\//, '')
    .replace(/\.git$/, '')
    .split('/')
    .filter(Boolean)
    .pop()!
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export class Toolkit {
  readonly builtins: ToolDef[];

  constructor(private options: ToolkitOptions) {
    this.builtins = this.createBuiltins();
  }

  /** Tools from every enabled MCP plus the built-ins. */
  catalog(): ToolDef[] {
    return [...this.options.registry.tools(), ...this.builtins];
  }

  find(name: string): ToolDef | undefined {
    return this.catalog().find((tool) => tool.name === name);
  }

  /** Validate + execute a tool call. Never throws. */
  async execute(name: string, rawArgs: unknown, ctx: Parameters<ToolDef['run']>[1]): Promise<ToolResult> {
    const tool = this.find(name);
    if (!tool) {
      const available = this.catalog().map((entry) => entry.name).join(', ');
      return toolFail(`Unknown tool "${name}". Available: ${available}`);
    }
    const parsed = tool.schema.safeParse(rawArgs ?? {});
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((issue) => `${issue.path.join('.') || 'args'}: ${issue.message}`)
        .join('; ');
      return toolFail(`Invalid arguments for ${name}: ${issues}`);
    }
    try {
      return await tool.run(parsed.data, ctx);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.options.log(`tool ${name} threw: ${message}`);
      return toolFail(`${name} failed: ${message}`);
    }
  }

  private createBuiltins(): ToolDef[] {
    const registry = this.options.registry;
    const router = this.options.router;
    const getConfig = (): AppConfig => this.options.getConfig();
    const setConfig = (config: AppConfig): void => this.options.setConfig(config);

    const sysInfo = defineTool({
      name: 'sys_info',
      title: 'System report',
      description: 'Environment, model, MCP health and installed skills at a glance.',
      params: '(no arguments)',
      danger: 'safe',
      schema: z.object({}),
      async run(): Promise<ToolResult> {
        const config = getConfig();
        const resolved = router.resolve();
        const health = registry.healthMap();
        const skills = await listInstalledSkills();
        const lines = [
          '# Environment',
          `platform : ${os.platform()} ${os.arch()}${isTermux ? ' (Termux)' : ''}`,
          `node     : ${process.version}`,
          `cwd      : ${process.cwd()}`,
          `home     : ${prettyPath(paths.home)}`,
          `workspace: ${prettyPath(config.workspace)}`,
          `git      : ${(await hasCommand('git')) ? 'yes' : 'no'}   adb: ${(await hasCommand('adb')) ? 'yes' : 'no'}   python: ${(await hasCommand('python3')) ? 'yes' : 'no'}`,
          '',
          '# Model',
          `provider : ${resolved.preset.label} (${resolved.preset.id})`,
          `model    : ${resolved.model}`,
          `reason   : ${resolved.reason}`,
          '',
          '# MCP servers',
          ...registry
            .list()
            .map(
              (module) =>
                `${registry.isEnabled(module.id) ? '▸' : '·'} ${module.id.padEnd(12)} ${module.tools.length} tools · ${health[module.id]?.status ?? 'unknown'} — ${health[module.id]?.detail ?? ''}`,
            ),
          '',
          '# Skills',
          skills.length
            ? skills.map((skill) => `• ${skill.slug} (${formatBytes(skill.bytes)})${config.skills.active.includes(skill.slug) ? ' [active]' : ''}`).join('\n')
            : '• none installed — ask: "install the unslop skill"',
          '',
          '# Config',
          ...describeConfig(config),
        ];
        return toolOk(lines.join('\n'));
      },
    });

    const sysShell = defineTool({
      name: 'sys_shell',
      title: 'Shell command',
      description: 'Run a bash command in the workspace (pipes, redirects allowed).',
      params: 'command:string, timeoutMs?:number',
      danger: 'dangerous',
      schema: z.object({
        command: z.string().min(1),
        timeoutMs: z.number().int().min(1000).max(600_000).optional(),
      }),
      async run(args, ctx): Promise<ToolResult> {
        const result = await runBash(args.command, {
          cwd: ctx.workspace,
          timeoutMs: args.timeoutMs ?? 120_000,
          signal: ctx.signal,
        });
        const output = [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join('\n');
        if (result.timedOut) return toolFail(`Timed out.\n${capOutput(output, 8000)}`);
        if (result.error) return toolFail(result.error);
        const header = `$ ${args.command}\nexit ${result.code} · ${result.durationMs}ms`;
        return result.code === 0
          ? toolOk(`${header}\n${capOutput(output || '(no output)', 10_000)}`)
          : toolFail(`${header}\n${capOutput(output || '(no output)', 10_000)}`);
      },
    });

    const skillList = defineTool({
      name: 'skill_list',
      title: 'List skills',
      description: 'List bundled and installed skills, and which are active.',
      params: '(no arguments)',
      danger: 'safe',
      schema: z.object({}),
      async run(): Promise<ToolResult> {
        const installed = await listInstalledSkills();
        const config = getConfig();
        const bundled = BUILTIN_SKILLS.map(
          (skill) =>
            `${installed.some((entry) => entry.slug === skill.slug) ? '✔' : '○'} ${skill.slug.padEnd(16)} ${skill.description}`,
        );
        return toolOk(
          [
            '# Bundled skills',
            ...bundled,
            '',
            '# Installed',
            installed.length
              ? installed
                  .map(
                    (skill) =>
                      `• ${skill.slug} · ${formatBytes(skill.bytes)} · ${skill.hasInstructions ? skill.instructionsFile : 'no instruction file'}${
                        config.skills.active.includes(skill.slug) ? ' · ACTIVE' : ''
                      }`,
                  )
                  .join('\n')
              : '• none',
            '',
            'Install with: skill_install { "slug": "superpowers" }',
          ].join('\n'),
        );
      },
    });

    const skillInstall = defineTool({
      name: 'skill_install',
      title: 'Install skill',
      description: 'Clone/install a skill by slug, owner/repo or GitHub URL, then activate it.',
      params: 'slug:string, force?:boolean, activate?:boolean',
      danger: 'write',
      schema: z.object({
        slug: z.string().min(2),
        force: z.boolean().optional(),
        activate: z.boolean().optional(),
      }),
      async run(args, ctx): Promise<ToolResult> {
        const definition = resolveSkillDefinition(args.slug);
        const logs: string[] = [];
        try {
          const installed = await installSkill(definition.slug, {
            force: args.force,
            onProgress: (message) => {
              logs.push(message);
              ctx.log(`skill: ${message}`);
            },
          });
          if (args.activate !== false) {
            const config = getConfig();
            if (!config.skills.active.includes(installed.slug)) {
              config.skills.active = [...config.skills.active, installed.slug];
              saveConfig(config);
              setConfig(config);
            }
          }
          return toolOk(
            [
              `✔ ${installed.name} installed at ${installed.path}`,
              `repo      : ${definition.url}`,
              `bytes     : ${formatBytes(installed.bytes)}`,
              `instructions: ${installed.instructionsFile ?? 'no SKILL.md/README.md found'}`,
              args.activate === false ? 'not activated' : 'activated — guidance is now in the system prompt',
              '',
              ...logs,
            ].join('\n'),
          );
        } catch (error) {
          return toolFail(`Skill install failed: ${(error as Error).message}\n\nTry manually:\n  git clone --depth 1 ${definition.url} ${paths.skills}/${definition.slug}`);
        }
      },
    });

    const skillActivate = defineTool({
      name: 'skill_activate',
      title: 'Activate skill',
      description: 'Add or remove a skill from the active prompt context.',
      params: 'slug:string, active:boolean',
      danger: 'safe',
      schema: z.object({ slug: z.string().min(1), active: z.boolean() }),
      async run(args): Promise<ToolResult> {
        const config = getConfig();
        const slug = args.slug.toLowerCase();
        const exists = (await listInstalledSkills()).some((skill) => skill.slug === slug);
        if (!exists) return toolFail(`Skill "${slug}" is not installed. Use skill_install first.`);
        config.skills.active = args.active
          ? [...new Set([...config.skills.active, slug])]
          : config.skills.active.filter((entry) => entry !== slug);
        saveConfig(config);
        setConfig(config);
        return toolOk(`${args.active ? '✔ activated' : '✔ deactivated'} ${slug}\nactive: ${config.skills.active.join(', ') || 'none'}`);
      },
    });

    const mcpList = defineTool({
      name: 'mcp_list',
      title: 'List MCP servers',
      description: 'Show every MCP server, its tools and enabled state.',
      params: '(no arguments)',
      danger: 'safe',
      schema: z.object({}),
      async run(): Promise<ToolResult> {
        return toolOk(
          registry
            .list()
            .map(
              (module) =>
                `${registry.isEnabled(module.id) ? '✔' : '○'} ${module.id.padEnd(12)} v${module.version} · ${module.tools.length} tools\n    ${module.blurb}\n    ${module.tools.map((tool) => tool.name).join(', ')}`,
            )
            .join('\n\n'),
        );
      },
    });

    const mcpInstall = defineTool({
      name: 'mcp_install',
      title: 'Install MCP server',
      description: 'Register an external stdio MCP server from an npm package or git URL.',
      params: 'name:string, source:string, command?:string, args?:string[]',
      danger: 'write',
      schema: z.object({
        name: z.string().min(2),
        source: z.string().min(2),
        command: z.string().optional(),
        args: z.array(z.string()).optional(),
      }),
      async run(args, ctx): Promise<ToolResult> {
        const slug = sanitizeSlug(args.name);
        if (!slug) return toolFail('Invalid MCP name.');
        await fs.mkdir(paths.mcp, { recursive: true });

        let command = args.command;
        let launchArgs = args.args ?? [];
        const notes: string[] = [];

        const isGit = /^(https?:\/\/|git@)/.test(args.source) || /^[\w.-]+\/[\w.-]+$/.test(args.source);

        if (!command && isGit) {
          if (!(await hasCommand('git'))) return toolFail('git is required to install an MCP from a repository.');
          const url = /^https?:|^git@/.test(args.source) ? args.source : `https://github.com/${args.source}.git`;
          const dir = path.join(paths.mcp, 'servers', slug);
          await fs.rm(dir, { recursive: true, force: true });
          await fs.mkdir(path.dirname(dir), { recursive: true });
          const clone = await run('git', ['clone', '--depth', '1', url, dir], { timeoutMs: 180_000 });
          if (clone.code !== 0) return toolFail(`git clone failed: ${(clone.stderr || clone.stdout).slice(0, 500)}`);
          const pkg = await fs
            .readFile(path.join(dir, 'package.json'), 'utf8')
            .then((raw) => JSON.parse(raw) as { main?: string; bin?: Record<string, string> | string })
            .catch(() => null);
          const binEntry = pkg?.bin ? (typeof pkg.bin === 'string' ? pkg.bin : Object.values(pkg.bin)[0]) : undefined;
          const entry = binEntry ?? pkg?.main ?? 'index.js';
          command = 'node';
          launchArgs = [path.join(dir, entry)];
          notes.push(`cloned into ${path.relative(paths.home, dir)}`);
          notes.push('run `npm install` in that folder if it has dependencies');
        } else if (!command) {
          command = 'npx';
          launchArgs = ['-y', args.source];
          notes.push(`will launch via npx -y ${args.source}`);
        }

        const manifest = {
          id: slug,
          name: args.name,
          description: `Installed by AI-FREEBUFF from ${args.source}`,
          command,
          args: launchArgs,
          enabled: true,
          installedAt: new Date().toISOString(),
        };
        const file = path.join(paths.mcp, `${slug}.json`);
        await fs.writeFile(file, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

        const config = getConfig();
        config.mcp[slug] = { enabled: true };
        saveConfig(config);
        setConfig(config);

        ctx.log(`mcp manifest written: ${file}`);
        return toolOk(
          [
            `✔ registered MCP "${slug}"`,
            `manifest: ${file}`,
            `command : ${command} ${launchArgs.join(' ')}`,
            ...notes,
            '',
            'Restart AI-FREEBUFF to load its tools (Ctrl+C twice, then run AI-FREEBUFF).',
          ].join('\n'),
        );
      },
    });

    const mcpToggle = defineTool({
      name: 'mcp_toggle',
      title: 'Enable/disable MCP',
      description: 'Turn an MCP server on or off and persist the choice.',
      params: 'id:string, enabled:boolean',
      danger: 'safe',
      schema: z.object({ id: z.string().min(1), enabled: z.boolean() }),
      async run(args): Promise<ToolResult> {
        const module = registry.get(args.id);
        if (!module) return toolFail(`No MCP with id "${args.id}".`);
        const config = getConfig();
        config.mcp[args.id] = { enabled: args.enabled };
        saveConfig(config);
        setConfig(config);
        registry.refresh(config);
        return toolOk(`${args.enabled ? '✔ enabled' : '✔ disabled'} ${args.id}`);
      },
    });

    const taskPlan = defineTool({
      name: 'task_plan',
      title: 'Plan a task',
      description: 'Record a short plan before a multi-step change.',
      params: 'steps:string[]',
      danger: 'safe',
      schema: z.object({ steps: z.array(z.string().min(1)).min(1).max(12) }),
      async run(args): Promise<ToolResult> {
        return toolOk(`Plan recorded:\n${args.steps.map((step, index) => `${index + 1}. ${step}`).join('\n')}`);
      },
    });

    return [sysInfo, sysShell, skillList, skillInstall, skillActivate, mcpList, mcpInstall, mcpToggle, taskPlan];
  }
}

/** Load config through the same normalisation the CLI uses. */
export function freshConfig(): AppConfig {
  return loadConfig();
}
