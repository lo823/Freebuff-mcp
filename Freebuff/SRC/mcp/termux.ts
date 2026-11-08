import path from 'node:path';
import { z } from 'zod';
import { hasCommand, run } from '../utils/shell';
import { defineTool, toolFail, toolOk, type McpModule, type ToolResult } from './types';

/**
 * MCP Termux — bridges to the `termux-*` helper commands.
 *
 * These binaries come from the `termux-api` package and need the separate
 * Termux:API Android app. The server degrades cleanly: every tool reports a
 * precise fix when a helper is missing, instead of throwing.
 */

async function call(binary: string, args: string[], timeoutMs = 20_000): Promise<ToolResult> {
  if (!(await hasCommand(binary))) {
    return toolFail(
      `${binary} is not installed.\n` +
        'Fix: pkg install termux-api, then install the "Termux:API" app from F-Droid.',
    );
  }
  const result = await run(binary, args, { timeoutMs });
  const output = [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join('\n');
  if (result.error) return toolFail(`${binary}: ${result.error}`);
  if (result.timedOut) return toolFail(`${binary} timed out after ${timeoutMs}ms.`);
  if (result.code !== 0) return toolFail(`${binary} exited with ${result.code}\n${output || '(no output)'}`);
  return toolOk(output || `${binary} completed.`);
}

const toast = defineTool({
  name: 'termux_toast',
  title: 'Android toast',
  description: 'Show a short Android toast message.',
  params: 'text:string, short?:boolean',
  danger: 'safe',
  schema: z.object({ text: z.string().min(1), short: z.boolean().optional() }),
  async run(args) {
    const flags = args.short ? ['-s'] : [];
    return call('termux-toast', [...flags, args.text]);
  },
});

const vibrate = defineTool({
  name: 'termux_vibrate',
  title: 'Vibrate',
  description: 'Vibrate the device for N milliseconds.',
  params: 'durationMs?:number',
  danger: 'safe',
  schema: z.object({ durationMs: z.number().int().min(50).max(10_000).optional() }),
  async run(args) {
    return call('termux-vibrate', ['-d', String(args.durationMs ?? 250)]);
  },
});

const notification = defineTool({
  name: 'termux_notification',
  title: 'Notification',
  description: 'Post an Android notification, optionally with a title and id.',
  params: 'content:string, title?:string, id?:number',
  danger: 'safe',
  schema: z.object({
    content: z.string().min(1),
    title: z.string().optional(),
    id: z.number().int().min(1).max(9999).optional(),
  }),
  async run(args) {
    const flags = ['--content', args.content];
    if (args.title) flags.push('--title', args.title);
    if (args.id) flags.push('--id', String(args.id));
    return call('termux-notification', flags);
  },
});

const clipboardGet = defineTool({
  name: 'termux_clipboard_get',
  title: 'Read clipboard',
  description: 'Read the current Android clipboard contents.',
  params: '(no arguments)',
  danger: 'safe',
  schema: z.object({}),
  async run() {
    return call('termux-clipboard-get', []);
  },
});

const clipboardSet = defineTool({
  name: 'termux_clipboard_set',
  title: 'Set clipboard',
  description: 'Copy text to the Android clipboard.',
  params: 'text:string',
  danger: 'safe',
  schema: z.object({ text: z.string() }),
  async run(args) {
    return call('termux-clipboard-set', [args.text]);
  },
});

const battery = defineTool({
  name: 'termux_battery',
  title: 'Battery status',
  description: 'Return battery level, temperature and charging state as JSON.',
  params: '(no arguments)',
  danger: 'safe',
  schema: z.object({}),
  async run() {
    return call('termux-battery-status', []);
  },
});

const wifi = defineTool({
  name: 'termux_wifi',
  title: 'Wi-Fi info',
  description: 'Return the current Wi-Fi connection info as JSON.',
  params: '(no arguments)',
  danger: 'safe',
  schema: z.object({}),
  async run() {
    return call('termux-wifi-connectioninfo', []);
  },
});

const speak = defineTool({
  name: 'termux_tts',
  title: 'Text to speech',
  description: 'Speak text aloud with the Android TTS engine (Thai supported when installed).',
  params: 'text:string, rate?:number',
  danger: 'safe',
  schema: z.object({ text: z.string().min(1), rate: z.number().min(0.25).max(3).optional() }),
  async run(args) {
    const flags = ['-r', String(args.rate ?? 1), args.text];
    return call('termux-tts-speak', flags, 60_000);
  },
});

const share = defineTool({
  name: 'termux_share',
  title: 'Share file',
  description: 'Open the Android share sheet for a file in the workspace.',
  params: 'file:string',
  danger: 'safe',
  schema: z.object({ file: z.string().min(1) }),
  async run(args, ctx) {
    const target = path.resolve(ctx.workspace, args.file);
    if (!target.startsWith(path.resolve(ctx.workspace))) return toolFail('File must be inside the workspace.');
    return call('termux-share', ['-a', 'send', target]);
  },
});

const sensor = defineTool({
  name: 'termux_sensor',
  title: 'Read sensor',
  description: 'Read one sample from a device sensor (accelerometer, gyroscope, light, …).',
  params: 'sensor:string',
  danger: 'safe',
  schema: z.object({ sensor: z.string().min(1) }),
  async run(args) {
    return call('termux-sensor', ['-s', args.sensor, '-n', '1'], 30_000);
  },
});

const torch = defineTool({
  name: 'termux_torch',
  title: 'Flashlight',
  description: 'Turn the camera flashlight on or off.',
  params: 'on:boolean',
  danger: 'safe',
  schema: z.object({ on: z.boolean() }),
  async run(args) {
    return call('termux-torch', [args.on ? 'on' : 'off']);
  },
});

const camera = defineTool({
  name: 'termux_camera',
  title: 'Take photo',
  description: 'Capture a photo with the camera and save it in the workspace.',
  params: 'file?:string, cameraId?:number',
  danger: 'write',
  schema: z.object({ file: z.string().optional(), cameraId: z.number().int().min(0).max(1).optional() }),
  async run(args, ctx) {
    const target = path.resolve(ctx.workspace, args.file ?? 'capture.jpg');
    if (!target.startsWith(path.resolve(ctx.workspace))) return toolFail('Output must be inside the workspace.');
    const result = await call('termux-camera-photo', ['-c', String(args.cameraId ?? 0), target], 60_000);
    return result.ok ? toolOk(`✔ photo saved to ${path.relative(ctx.workspace, target)}`) : result;
  },
});

const location = defineTool({
  name: 'termux_location',
  title: 'Location',
  description: 'Get a one-shot GPS/network location fix as JSON.',
  params: 'provider?:string',
  danger: 'safe',
  schema: z.object({ provider: z.enum(['gps', 'network', 'passive']).optional() }),
  async run(args) {
    return call('termux-location', ['-p', args.provider ?? 'network', '-r', 'once'], 45_000);
  },
});

const sms = defineTool({
  name: 'termux_sms',
  title: 'Send SMS',
  description: 'Send an SMS from the device. This costs real money and is irreversible.',
  params: 'number:string, message:string, confirm:boolean',
  danger: 'dangerous',
  schema: z.object({
    number: z.string().min(3),
    message: z.string().min(1).max(1000),
    confirm: z.boolean(),
  }),
  async run(args) {
    if (!args.confirm) return toolFail('Refusing to send SMS without confirm=true.');
    return call('termux-sms-send', ['-n', args.number, args.message], 30_000);
  },
});

const volume = defineTool({
  name: 'termux_volume',
  title: 'Set volume',
  description: 'Set a volume stream level (music, ring, alarm, notification, call).',
  params: 'stream:string, level:number',
  danger: 'safe',
  schema: z.object({
    stream: z.enum(['music', 'ring', 'alarm', 'notification', 'call', 'system']),
    level: z.number().int().min(0).max(15),
  }),
  async run(args) {
    return call('termux-volume', [args.stream, String(args.level)]);
  },
});

const dialog = defineTool({
  name: 'termux_dialog',
  title: 'Native dialog',
  description: 'Show a native Android text/confirm dialog and return the input.',
  params: 'type?:string, title?:string, hint?:string',
  danger: 'safe',
  schema: z.object({
    type: z.enum(['text', 'confirm', 'checkbox']).optional(),
    title: z.string().optional(),
    hint: z.string().optional(),
  }),
  async run(args) {
    const flags = ['-t', args.type ?? 'text'];
    if (args.title) flags.push('-i', args.title);
    if (args.hint) flags.push('-h', args.hint);
    return call('termux-dialog', flags, 120_000);
  },
});

export const termuxMcp: McpModule = {
  id: 'termux',
  name: 'MCP Termux',
  blurb: 'Notifications, clipboard, TTS, sensors, torch, SMS.',
  version: '1.0.0',
  tools: [
    toast,
    vibrate,
    notification,
    clipboardGet,
    clipboardSet,
    battery,
    wifi,
    speak,
    share,
    sensor,
    torch,
    camera,
    location,
    sms,
    volume,
    dialog,
  ],
  async probe() {
    const ready = await hasCommand('termux-toast');
    return ready
      ? { status: 'ready', detail: 'termux-api detected' }
      : { status: 'degraded', detail: 'termux-api missing — pkg install termux-api' };
  },
};
