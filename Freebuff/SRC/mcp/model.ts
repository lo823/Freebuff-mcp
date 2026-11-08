import { z } from 'zod';
import { PROVIDERS, ModelRouter, isConfigured } from '../agent/model-router';
import { loadConfig, saveConfig } from '../utils/config';
import { readUsage, resetUsage } from '../utils/usage';
import { defineTool, toolFail, toolOk, type McpModule } from './types';

/**
 * MCP Model — inspect and switch the brain.
 *
 * Reads live environment keys so it always reflects reality: a key exported
 * after launch is picked up the next time the router resolves.
 */

const info = defineTool({
  name: 'model_info',
  title: 'Current model',
  description: 'Show which provider/model the agent is using and why.',
  params: '(no arguments)',
  danger: 'safe',
  schema: z.object({}),
  async run(_args, ctx) {
    const router = new ModelRouter(loadConfig());
    const resolved = router.resolve();
    return toolOk(
      [
        `provider : ${resolved.preset.label} (${resolved.preset.id})`,
        `model    : ${resolved.model}`,
        `endpoint : ${resolved.baseUrl || '(local planner)'}`,
        `reason   : ${resolved.reason}`,
        `mode     : ${resolved.preset.kind}`,
        `config   : ${ctx.config.model.provider} / ${ctx.config.model.model || 'auto'}`,
      ].join('\n'),
    );
  },
});

const providers = defineTool({
  name: 'model_providers',
  title: 'List providers',
  description: 'List every supported provider, whether it is configured, and how to set it up.',
  params: '(no arguments)',
  danger: 'safe',
  schema: z.object({}),
  async run() {
    const lines = PROVIDERS.map((preset) => {
      const ready = isConfigured(preset);
      const mark = ready ? '✔' : '○';
      return `${mark} ${preset.id.padEnd(12)} ${preset.label}\n    env   : ${preset.envKeys.join(', ') || '(none)'}\n    model : ${preset.defaultModel}\n    setup : ${preset.installHint}`;
    });
    return toolOk(lines.join('\n\n'));
  },
});

const list = defineTool({
  name: 'model_list',
  title: 'List models',
  description: 'Ask the active provider which models it exposes.',
  params: '(no arguments)',
  danger: 'safe',
  schema: z.object({}),
  async run() {
    const router = new ModelRouter(loadConfig());
    const resolved = router.resolve();
    const models = resolved.provider.listModels ? await resolved.provider.listModels() : [];
    const fallback = resolved.preset.models;
    const items = models.length ? models : fallback;
    return toolOk(
      items.length
        ? `${resolved.preset.label}: ${items.length} model(s)\n${items.slice(0, 60).join('\n')}`
        : `${resolved.preset.label} does not publish a model list. Current model: ${resolved.model}`,
    );
  },
});

const use = defineTool({
  name: 'model_use',
  title: 'Switch model',
  description: 'Pin the agent to a provider and model (persisted to config.json).',
  params: 'provider:string, model?:string',
  danger: 'write',
  schema: z.object({ provider: z.string().min(2), model: z.string().optional() }),
  async run(args) {
    const preset = PROVIDERS.find((entry) => entry.id === args.provider);
    if (!preset) {
      return toolFail(`Unknown provider "${args.provider}". Known: ${PROVIDERS.map((entry) => entry.id).join(', ')}`);
    }
    const config = loadConfig();
    const keepExisting = preset.id === config.model.provider ? config.model.model : '';
    const nextModel = args.model || keepExisting || preset.defaultModel;
    config.model.provider = preset.id;
    config.model.model = nextModel;
    saveConfig(config);
    const requiresKey = preset.envKeys.length > 0 && !isConfigured(preset);
    return toolOk(
      `✔ pinned to ${preset.id} / ${config.model.model}` +
        (requiresKey ? `\n⚠ set ${preset.envKeys.join(' or ')} in this shell to authenticate.` : ''),
    );
  },
});

const usage = defineTool({
  name: 'model_usage',
  title: 'Token usage',
  description: 'Show accumulated token usage and recent calls.',
  params: 'reset?:boolean',
  danger: 'write',
  schema: z.object({ reset: z.boolean().optional() }),
  async run(args) {
    if (args.reset) {
      resetUsage();
      return toolOk('✔ usage ledger reset.');
    }
    const ledger = readUsage();
    const recent = ledger.entries
      .slice(-8)
      .reverse()
      .map((entry) => `${entry.at} · ${entry.provider}/${entry.model} · ${entry.total} tok`);
    return toolOk(
      [
        `total     : ${ledger.total.total} tokens`,
        `prompt    : ${ledger.total.prompt}`,
        `completion: ${ledger.total.completion}`,
        `calls     : ${ledger.entries.length}`,
        '',
        ...recent,
      ].join('\n'),
    );
  },
});

const health = defineTool({
  name: 'model_health',
  title: 'Provider health',
  description: 'Probe every configured provider endpoint and report reachability.',
  params: '(no arguments)',
  danger: 'safe',
  schema: z.object({}),
  async run() {
    const router = new ModelRouter(loadConfig());
    const rows = await router.status();
    return toolOk(
      rows
        .map((row) => `${row.reachable ? '✔' : row.configured ? '▲' : '○'} ${row.preset.id.padEnd(12)} ${row.detail}`)
        .join('\n'),
    );
  },
});

export const modelMcp: McpModule = {
  id: 'model',
  name: 'MCP Model',
  blurb: 'Provider discovery, switching and token accounting.',
  version: '1.0.0',
  tools: [info, providers, list, use, usage, health],
  async probe() {
    const router = new ModelRouter(loadConfig());
    const resolved = router.resolve();
    return {
      status: resolved.preset.kind === 'offline' ? 'degraded' : 'ready',
      detail: `${resolved.preset.label} · ${resolved.model}`,
    };
  },
};
