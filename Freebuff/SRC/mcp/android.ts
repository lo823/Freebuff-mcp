import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { firstCommand, hasCommand, run, runBinary } from '../utils/shell';
import { capOutput, formatBytes } from '../utils/text';
import { defineTool, toolFail, toolOk, type McpModule, type ToolResult } from './types';

/**
 * MCP Android — device automation through `adb`.
 *
 * Works with USB debugging, wireless debugging (`adb connect host:port`) and
 * the built-in Android emulator. Everything is read from the *connected*
 * device; nothing is hardcoded to this phone.
 */

const NO_DEVICE_HINT =
  'No Android device responded.\n' +
  '• USB: enable Developer options → USB debugging, then `adb devices`.\n' +
  '• Wireless: `adb pair host:port` then `adb connect host:port`.\n' +
  '• Termux note: `pkg install android-tools` provides adb.';

async function adbCall(args: string[], timeoutMs = 30_000): Promise<ToolResult> {
  if (!(await hasCommand('adb'))) {
    return toolFail('adb is not installed. Fix: pkg install android-tools');
  }
  const result = await run('adb', args, { timeoutMs });
  const output = [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join('\n');
  if (result.timedOut) return toolFail(`adb ${args[0] ?? ''} timed out.`);
  if (result.code !== 0 || /no devices|device offline|unauthorized/i.test(output)) {
    return toolFail(`${output || `adb exited ${result.code}`}\n\n${NO_DEVICE_HINT}`);
  }
  return toolOk(output || 'ok');
}

const devices = defineTool({
  name: 'android_devices',
  title: 'List devices',
  description: 'List connected Android devices and emulators.',
  params: '(no arguments)',
  danger: 'safe',
  schema: z.object({}),
  async run() {
    return adbCall(['devices', '-l']);
  },
});

const shell = defineTool({
  name: 'android_shell',
  title: 'ADB shell',
  description: 'Run a shell command on the connected Android device.',
  params: 'command:string, timeoutMs?:number',
  danger: 'dangerous',
  schema: z.object({ command: z.string().min(1), timeoutMs: z.number().int().min(1000).max(180_000).optional() }),
  async run(args) {
    return adbCall(['shell', args.command], args.timeoutMs ?? 30_000);
  },
});

const packages = defineTool({
  name: 'android_packages',
  title: 'List packages',
  description: 'List installed packages, optionally filtered by substring.',
  params: 'filter?:string, thirdPartyOnly?:boolean',
  danger: 'safe',
  schema: z.object({ filter: z.string().optional(), thirdPartyOnly: z.boolean().optional() }),
  async run(args) {
    const flags = ['shell', 'pm', 'list', 'packages'];
    if (args.thirdPartyOnly) flags.push('-3');
    const result = await adbCall(flags);
    if (!result.ok || !args.filter) return result;
    const filter = args.filter.toLowerCase();
    const lines = result.output
      .split('\n')
      .filter((line) => line.toLowerCase().includes(filter));
    return toolOk(lines.join('\n') || `No package matching "${args.filter}".`);
  },
});

const install = defineTool({
  name: 'android_install',
  title: 'Install APK',
  description: 'Install (or reinstall) an APK from the workspace.',
  params: 'apk:string, reinstall?:boolean, grantPermissions?:boolean',
  danger: 'dangerous',
  schema: z.object({
    apk: z.string().min(1),
    reinstall: z.boolean().optional(),
    grantPermissions: z.boolean().optional(),
  }),
  async run(args, ctx) {
    const target = path.resolve(ctx.workspace, args.apk);
    if (!target.startsWith(path.resolve(ctx.workspace))) return toolFail('APK must live inside the workspace.');
    await fs.access(target).catch(() => {
      throw new Error(`APK not found: ${args.apk}`);
    });
    const flags = ['install'];
    if (args.reinstall) flags.push('-r');
    if (args.grantPermissions) flags.push('-g');
    flags.push(target);
    return adbCall(flags, 180_000);
  },
});

const uninstall = defineTool({
  name: 'android_uninstall',
  title: 'Uninstall app',
  description: 'Uninstall a package from the connected device.',
  params: 'packageName:string',
  danger: 'dangerous',
  schema: z.object({ packageName: z.string().min(3) }),
  async run(args) {
    return adbCall(['uninstall', args.packageName], 60_000);
  },
});

const screenshot = defineTool({
  name: 'android_screenshot',
  title: 'Screenshot',
  description: 'Capture the device screen and save a PNG in the workspace.',
  params: 'file?:string',
  danger: 'write',
  schema: z.object({ file: z.string().optional() }),
  async run(args, ctx) {
    if (!(await hasCommand('adb'))) return toolFail('adb is not installed. Fix: pkg install android-tools');
    const result = await runBinary('adb', ['exec-out', 'screencap', '-p'], { timeoutMs: 30_000 });
    if (result.code !== 0 || result.stdout.length === 0) {
      return toolFail(`Screenshot failed: ${result.error || result.stderr.trim() || 'empty output'}\n\n${NO_DEVICE_HINT}`);
    }
    // Some Android builds prepend CRLF before the PNG signature.
    const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    let data = result.stdout;
    const offset = data.indexOf(signature);
    if (offset > 0) data = data.subarray(offset);
    const target = path.resolve(ctx.workspace, args.file ?? 'screenshot.png');
    if (!target.startsWith(path.resolve(ctx.workspace))) return toolFail('Output must be inside the workspace.');
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, data);
    return toolOk(`✔ screenshot ${formatBytes(data.length)} → ${path.relative(ctx.workspace, target)}`);
  },
});

const tap = defineTool({
  name: 'android_tap',
  title: 'Tap',
  description: 'Tap screen coordinates on the device.',
  params: 'x:number, y:number',
  danger: 'write',
  schema: z.object({ x: z.number().int().min(0), y: z.number().int().min(0) }),
  async run(args) {
    return adbCall(['shell', 'input', 'tap', String(args.x), String(args.y)]);
  },
});

const swipe = defineTool({
  name: 'android_swipe',
  title: 'Swipe',
  description: 'Swipe between two screen coordinates.',
  params: 'x1:number, y1:number, x2:number, y2:number, durationMs?:number',
  danger: 'write',
  schema: z.object({
    x1: z.number().int().min(0),
    y1: z.number().int().min(0),
    x2: z.number().int().min(0),
    y2: z.number().int().min(0),
    durationMs: z.number().int().min(50).max(5000).optional(),
  }),
  async run(args) {
    return adbCall([
      'shell',
      'input',
      'swipe',
      String(args.x1),
      String(args.y1),
      String(args.x2),
      String(args.y2),
      String(args.durationMs ?? 300),
    ]);
  },
});

const typeText = defineTool({
  name: 'android_text',
  title: 'Type text',
  description: 'Inject text into the focused field (spaces are encoded for adb).',
  params: 'text:string',
  danger: 'write',
  schema: z.object({ text: z.string().min(1) }),
  async run(args) {
    // `input text` treats spaces as argument separators.
    const encoded = args.text.replace(/\s/g, '%s').replace(/(["'`$\\])/g, '\\$1');
    return adbCall(['shell', 'input', 'text', encoded]);
  },
});

const keyEvent = defineTool({
  name: 'android_key',
  title: 'Key event',
  description: 'Send a key event (e.g. KEYCODE_HOME, KEYCODE_BACK, KEYCODE_ENTER).',
  params: 'keycode:string',
  danger: 'write',
  schema: z.object({ keycode: z.string().regex(/^(KEYCODE_)?[A-Z0-9_]+$/i) }),
  async run(args) {
    return adbCall(['shell', 'input', 'keyevent', args.keycode]);
  },
});

const logcat = defineTool({
  name: 'android_logcat',
  title: 'Logcat',
  description: 'Capture recent device logs (optionally filtered).',
  params: 'lines?:number, filter?:string',
  danger: 'safe',
  schema: z.object({ lines: z.number().int().min(1).max(2000).optional(), filter: z.string().optional() }),
  async run(args) {
    const count = args.lines ?? 120;
    const result = await adbCall(['logcat', '-d', '-t', String(count)], 30_000);
    if (!result.ok) return result;
    if (!args.filter) return toolOk(capOutput(result.output, 14_000));
    const needle = args.filter.toLowerCase();
    return toolOk(capOutput(result.output.split('\n').filter((line) => line.toLowerCase().includes(needle)).join('\n'), 14_000));
  },
});

const uiDump = defineTool({
  name: 'android_ui_dump',
  title: 'Dump UI tree',
  description: 'Dump the current view hierarchy XML; useful for finding tap targets.',
  params: 'file?:string',
  danger: 'safe',
  schema: z.object({ file: z.string().optional() }),
  async run(args, ctx) {
    const remote = '/sdcard/ai-freebuff-ui.xml';
    const dump = await adbCall(['shell', 'uiautomator', 'dump', remote], 45_000);
    if (!dump.ok) return dump;
    const local = await resolveLocal(ctx.workspace, args.file ?? 'ui-dump.xml');
    const pull = await adbCall(['pull', remote, local], 45_000);
    if (!pull.ok) return pull;
    const xml = await fs.readFile(local, 'utf8').catch(() => '');
    const nodes = [...xml.matchAll(/text="([^"]+)"/g)].map((match) => match[1]).filter(Boolean);
    return toolOk(`✔ saved ${path.relative(ctx.workspace, local)}\nVisible text: ${nodes.slice(0, 40).join(' | ') || '(none)'}`);
  },
});

const apkInfo = defineTool({
  name: 'android_apk_info',
  title: 'APK info',
  description: 'Inspect an APK: badging, signature status and file listing.',
  params: 'apk:string',
  danger: 'safe',
  schema: z.object({ apk: z.string().min(1) }),
  async run(args, ctx) {
    const target = path.resolve(ctx.workspace, args.apk);
    if (!target.startsWith(path.resolve(ctx.workspace))) return toolFail('APK must live inside the workspace.');
    const stat = await fs.stat(target).catch(() => null);
    if (!stat) return toolFail(`APK not found: ${args.apk}`);

    const sections: string[] = [`file    : ${args.apk} (${formatBytes(stat.size)})`];
    const aapt = await firstCommand(['aapt', 'aapt2']);
    if (aapt) {
      const badging = await run(aapt, ['dump', 'badging', target], { timeoutMs: 20_000 });
      if (badging.code === 0) sections.push(`\n# badging\n${badging.stdout.trim().slice(0, 4000)}`);
    } else {
      sections.push('aapt  : not installed (pkg install aapt)');
    }
    if (await hasCommand('apksigner')) {
      const verify = await run('apksigner', ['verify', '--print-certs', target], { timeoutMs: 20_000 });
      sections.push(`\n# signature\n${(verify.stdout + verify.stderr).trim().slice(0, 1500) || 'unverified'}`);
    }
    if (await hasCommand('unzip')) {
      const list = await run('unzip', ['-l', target], { timeoutMs: 20_000 });
      const lines = list.stdout.split('\n').slice(0, 40).join('\n');
      sections.push(`\n# contents (head)\n${lines}`);
    }
    return toolOk(sections.join('\n'));
  },
});

async function resolveLocal(workspace: string, relative: string): Promise<string> {
  const target = path.resolve(workspace, relative);
  if (!target.startsWith(path.resolve(workspace))) throw new Error('Output must be inside the workspace.');
  await fs.mkdir(path.dirname(target), { recursive: true });
  return target;
}

export const androidMcp: McpModule = {
  id: 'android',
  name: 'MCP Android',
  blurb: 'ADB device control, screenshots, APK inspection.',
  version: '1.0.0',
  tools: [
    devices,
    shell,
    packages,
    install,
    uninstall,
    screenshot,
    tap,
    swipe,
    typeText,
    keyEvent,
    logcat,
    uiDump,
    apkInfo,
  ],
  async probe() {
    if (!(await hasCommand('adb'))) return { status: 'degraded', detail: 'adb missing — pkg install android-tools' };
    const result = await run('adb', ['devices'], { timeoutMs: 6000 });
    const connected = result.stdout.split('\n').filter((line) => /\tdevice$/.test(line.trim()));
    return connected.length
      ? { status: 'ready', detail: `${connected.length} device(s) connected` }
      : { status: 'degraded', detail: 'adb installed, no device connected' };
  },
};
