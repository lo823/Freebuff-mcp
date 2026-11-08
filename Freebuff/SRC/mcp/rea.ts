import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { firstCommand, hasCommand, run } from '../utils/shell';
import { capOutput, formatBytes } from '../utils/text';
import { defineTool, toolFail, toolOk, type McpModule, type ToolResult } from './types';

/**
 * MCP REA — "Reverse Engineer Anything".
 *
 * Follows the evidence-first workflow of https://github.com/morluto/rea:
 *   1. identify the artifact and its capabilities,
 *   2. gather cheap evidence (hashes, entropy, strings, structure),
 *   3. escalate to decompilers only when the cheap evidence justifies it,
 *   4. write a report that separates facts from hypotheses.
 *
 * All heavy lifting is delegated to tools that actually exist on the device;
 * missing tools are reported as degraded capabilities with install hints
 * instead of pretending the analysis happened.
 */

const SAMPLE_BYTES = 8 * 1024 * 1024;

const MAGIC: Array<{ signature: number[]; offset?: number; type: string; kind: string }> = [
  { signature: [0x7f, 0x45, 0x4c, 0x46], type: 'ELF binary', kind: 'elf' },
  { signature: [0x50, 0x4b, 0x03, 0x04], type: 'ZIP container', kind: 'zip' },
  { signature: [0x64, 0x65, 0x78, 0x0a], type: 'Dalvik DEX', kind: 'dex' },
  { signature: [0x4d, 0x5a], type: 'PE executable', kind: 'pe' },
  { signature: [0xcf, 0xfa, 0xed, 0xfe], type: 'Mach-O', kind: 'macho' },
  { signature: [0xca, 0xfe, 0xba, 0xbe], type: 'Java class / Mach-O fat', kind: 'java' },
  { signature: [0x89, 0x50, 0x4e, 0x47], type: 'PNG image', kind: 'image' },
  { signature: [0xff, 0xd8, 0xff], type: 'JPEG image', kind: 'image' },
  { signature: [0x47, 0x49, 0x46, 0x38], type: 'GIF image', kind: 'image' },
  { signature: [0x25, 0x50, 0x44, 0x46], type: 'PDF document', kind: 'pdf' },
  { signature: [0x53, 0x51, 0x4c, 0x69], type: 'SQLite database', kind: 'sqlite' },
];

interface Artifact {
  path: string;
  relative: string;
  size: number;
  type: string;
  kind: string;
  extension: string;
  sha256: string;
  sha1: string;
  md5: string;
  entropy: number;
  magicHex: string;
  head: string;
}

interface ScanEvidence {
  artifact: Artifact;
  entropyVerdict: string;
  strings: string[];
  urls: string[];
  ips: string[];
  secrets: string[];
  packages: string[];
  indicators: string[];
  zipEntries: string[];
  scannedAt: string;
}

const cache = new Map<string, ScanEvidence>();

async function resolveArtifact(workspace: string, target: string): Promise<string> {
  const absolute = path.resolve(workspace, target);
  if (!absolute.startsWith(path.resolve(workspace))) throw new Error('Artifact must be inside the workspace.');
  await fsp.access(absolute);
  return absolute;
}

function entropy(buffer: Buffer): number {
  if (buffer.length === 0) return 0;
  const counts = new Array<number>(256).fill(0);
  for (const byte of buffer) counts[byte] = (counts[byte] ?? 0) + 1;
  let result = 0;
  for (const count of counts) {
    if (!count) continue;
    const probability = count / buffer.length;
    result -= probability * Math.log2(probability);
  }
  return result;
}

async function hashFile(file: string, algorithm: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash(algorithm);
    const stream = fs.createReadStream(file);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

function detectMagic(head: Buffer): { type: string; kind: string } {
  for (const entry of MAGIC) {
    const offset = entry.offset ?? 0;
    if (head.length < offset + entry.signature.length) continue;
    const matches = entry.signature.every((byte, index) => head[offset + index] === byte);
    if (matches) return { type: entry.type, kind: entry.kind };
  }
  if (head.slice(0, 2).toString('utf8') === '#!') return { type: 'Script (shebang)', kind: 'script' };
  const text = head.slice(0, 512).toString('utf8');
  if (/^[\x09\x0a\x0d\x20-\x7e]*$/.test(text)) return { type: 'Text', kind: 'text' };
  return { type: 'Unknown binary', kind: 'binary' };
}

function stripAnsi(input: string): string {
  return input.replace(/\u001B\[[0-9;]*m/g, '');
}

function extractStrings(buffer: Buffer, minLength = 5): string[] {
  const output: string[] = [];
  let current = '';
  for (const byte of buffer) {
    if (byte === 0x09 || byte === 0x0a || byte === 0x0d || (byte >= 0x20 && byte <= 0x7e)) {
      current += String.fromCharCode(byte === 0x0a || byte === 0x0d || byte === 0x09 ? 0x20 : byte);
    } else {
      if (current.length >= minLength) output.push(current.trim());
      current = '';
    }
  }
  if (current.length >= minLength) output.push(current.trim());
  return output.filter(Boolean);
}

function analyzeStrings(strings: string[]): Omit<ScanEvidence, 'artifact' | 'entropyVerdict' | 'strings' | 'zipEntries' | 'scannedAt'> {
  const urls = [...new Set(strings.filter((value) => /^https?:\/\/\S{4,}$/i.test(value)))].slice(0, 40);
  const ips = [...new Set(strings.filter((value) => /\b(?:\d{1,3}\.){3}\d{1,3}\b/.test(value)))].slice(0, 20);
  const secrets = [
    ...new Set(
      strings.filter((value) =>
        /(?:api[_-]?key|secret|token|password|passwd|bearer)\s*[:=]\s*\S{6,}/i.test(value) ||
        /AKIA[0-9A-Z]{16}/.test(value) ||
        /sk-[A-Za-z0-9]{20,}/.test(value) ||
        /gh[pousr]_[A-Za-z0-9]{20,}/.test(value),
      ),
    ),
  ].slice(0, 20);
  const packages = [...new Set(strings.filter((value) => /^(?:com|org|net|io|dev)\.[\w.]{4,}$/.test(value)))].slice(0, 40);
  const indicators: string[] = [];
  const joined = strings.join('\n');
  const checks: Array<[RegExp, string]> = [
    [/android\.(?:content|app|os)\./m, 'Android framework references'],
    [/ReactNative|react-native/m, 'React Native bundle markers'],
    [/Flutter|libflutter/m, 'Flutter runtime markers'],
    [/UnityPlayer|il2cpp/m, 'Unity runtime markers'],
    [/GodotEngine|godot/m, 'Godot engine markers'],
    [/__pyinstaller|PyInstaller/m, 'PyInstaller bundle markers'],
    [/eval\(|new Function\(/m, 'Dynamic code evaluation'],
    [/child_process|execSync|spawn\(/m, 'Process execution APIs'],
    [/AES|RSA|ChaCha|HMAC/m, 'Cryptography references'],
    [/\.onion\b/m, 'Tor hidden service reference'],
    [/api\.telegram\.org|discord\.com\/api|webhook/m, 'Messaging API endpoints'],
    [/\/data\/local\/tmp|getExternalFilesDir/m, 'Android storage paths'],
    [/debug\.isDebuggerConnected|ptrace|TracerPid/m, 'Anti-debugging hints'],
    [/X509TrustManager|checkServerTrusted/m, 'TLS trust manipulation'],
  ];
  for (const [pattern, label] of checks) if (pattern.test(joined)) indicators.push(label);
  return { urls, ips, secrets, packages, indicators };
}

async function inspect(file: string, workspace: string): Promise<Artifact> {
  const stat = await fsp.stat(file);
  const handle = await fsp.open(file, 'r');
  const headBuffer = Buffer.alloc(Math.min(512, stat.size));
  if (headBuffer.length > 0) await handle.read(headBuffer, 0, headBuffer.length, 0);
  await handle.close();

  const sampleLength = Math.min(stat.size, SAMPLE_BYTES);
  const sample = Buffer.alloc(sampleLength);
  const sampleHandle = await fsp.open(file, 'r');
  if (sampleLength > 0) await sampleHandle.read(sample, 0, sampleLength, 0);
  await sampleHandle.close();

  const detected = detectMagic(headBuffer);
  const extension = path.extname(file).toLowerCase();
  let type = detected.type;
  if (type === 'ZIP container') {
    const listing = await listZip(file);
    if (listing.some((entry) => entry.endsWith('classes.dex'))) type = 'Android APK (ZIP + DEX)';
    else if (listing.some((entry) => entry.startsWith('META-INF/'))) type = 'ZIP / JAR container';
  }

  const [sha256, sha1, md5] = await Promise.all([hashFile(file, 'sha256'), hashFile(file, 'sha1'), hashFile(file, 'md5')]);

  return {
    path: file,
    relative: path.relative(workspace, file),
    size: stat.size,
    type,
    kind: detected.kind,
    extension,
    sha256,
    sha1,
    md5,
    entropy: Number(entropy(sample).toFixed(3)),
    magicHex: headBuffer.subarray(0, 16).toString('hex'),
    head: headBuffer.subarray(0, 32).toString('hex'),
  };
}

async function listZip(file: string): Promise<string[]> {
  if (!(await hasCommand('unzip'))) return [];
  const result = await run('unzip', ['-Z1', file], { timeoutMs: 20_000 });
  if (result.code !== 0) return [];
  return result.stdout.split('\n').map((line) => line.trim()).filter(Boolean);
}

function entropyVerdict(value: number): string {
  if (value < 4.5) return 'low — plain text / structured data';
  if (value < 6.5) return 'moderate — compiled code or mixed content';
  if (value < 7.5) return 'high — compressed or packed data';
  return 'very high — encrypted, packed, or random';
}

async function buildScan(file: string, workspace: string): Promise<ScanEvidence> {
  const artifact = await inspect(file, workspace);
  const sampleLength = Math.min(artifact.size, SAMPLE_BYTES);
  const handle = await fsp.open(file, 'r');
  const sample = Buffer.alloc(sampleLength);
  if (sampleLength > 0) await handle.read(sample, 0, sampleLength, 0);
  await handle.close();

  const strings = extractStrings(sample, 5);
  const evidence: ScanEvidence = {
    artifact,
    entropyVerdict: entropyVerdict(artifact.entropy),
    strings: strings.slice(0, 400),
    zipEntries: artifact.kind === 'zip' || artifact.type.includes('APK') ? (await listZip(file)).slice(0, 80) : [],
    scannedAt: new Date().toISOString(),
    ...analyzeStrings(strings),
  };
  cache.set(artifact.path, evidence);
  return evidence;
}

/* ------------------------------------------------------------------ */
/* Tools                                                               */
/* ------------------------------------------------------------------ */

const capabilities = defineTool({
  name: 'rea_capabilities',
  title: 'REA capabilities',
  description: 'Report which reverse-engineering tools are installed and what they enable.',
  params: '(no arguments)',
  danger: 'safe',
  schema: z.object({}),
  async run() {
    const tools: Array<[string, string, string]> = [
      ['file', 'basic', 'magic-byte identification'],
      ['strings', 'basic', 'string extraction'],
      ['unzip', 'basic', 'archive listing/extraction'],
      ['sha256sum', 'basic', 'hashing'],
      ['readelf', 'elf', 'ELF headers/sections'],
      ['objdump', 'elf', 'disassembly'],
      ['nm', 'elf', 'symbol table'],
      ['r2', 'elf', 'radare2 analysis'],
      ['apktool', 'apk', 'resource + smali decoding'],
      ['jadx', 'apk', 'DEX → Java decompilation'],
      ['aapt', 'apk', 'manifest badging'],
      ['apksigner', 'apk', 'signature verification'],
      ['ghidra', 'native', 'Ghidra headless decompiler'],
      ['python3', 'scripting', 'custom analysis scripts'],
      ['node', 'scripting', 'JS/TS analysis'],
    ];
    const rows: string[] = [];
    for (const [binary, tier, purpose] of tools) {
      const present = await hasCommand(binary);
      rows.push(`${present ? '✔' : '○'} ${binary.padEnd(11)} ${tier.padEnd(9)} ${purpose}`);
    }
    const installHint = await hasCommand('pkg')
      ? '\nInstall more: pkg install binutils apktool jadx file'
      : '\nInstall more tools with your package manager (binutils, apktool, jadx).';
    return toolOk(`${rows.join('\n')}${installHint}`);
  },
});

const detect = defineTool({
  name: 'rea_detect',
  title: 'Identify artifact',
  description: 'Identify a file by magic bytes and hash it (sha256/sha1/md5).',
  params: 'path:string',
  danger: 'safe',
  schema: z.object({ path: z.string().min(1) }),
  async run(args, ctx) {
    const file = await resolveArtifact(ctx.workspace, args.path).catch(() => null);
    if (!file) return toolFail(`Not found in workspace: ${args.path}`);
    const artifact = await inspect(file, ctx.workspace);
    return toolOk(
      [
        `path      : ${artifact.relative}`,
        `type      : ${artifact.type} (${artifact.kind})`,
        `size      : ${formatBytes(artifact.size)}`,
        `sha256    : ${artifact.sha256}`,
        `sha1      : ${artifact.sha1}`,
        `md5       : ${artifact.md5}`,
        `entropy   : ${artifact.entropy} bits/byte — ${entropyVerdict(artifact.entropy)}`,
        `magic     : ${artifact.magicHex}  (${artifact.head})`,
      ].join('\n'),
    );
  },
});

const stringsTool = defineTool({
  name: 'rea_strings',
  title: 'Extract strings',
  description: 'Extract printable strings, optionally filtered by regex.',
  params: 'path:string, minLength?:number, filter?:string, limit?:number',
  danger: 'safe',
  schema: z.object({
    path: z.string().min(1),
    minLength: z.number().int().min(3).max(64).optional(),
    filter: z.string().optional(),
    limit: z.number().int().min(1).max(2000).optional(),
  }),
  async run(args, ctx) {
    const file = await resolveArtifact(ctx.workspace, args.path).catch(() => null);
    if (!file) return toolFail(`Not found in workspace: ${args.path}`);
    const handle = await fsp.open(file, 'r');
    const stat = await handle.stat();
    const length = Math.min(stat.size, SAMPLE_BYTES);
    const buffer = Buffer.alloc(length);
    if (length > 0) await handle.read(buffer, 0, length, 0);
    await handle.close();

    let values = extractStrings(buffer, args.minLength ?? 5);
    if (args.filter) {
      let regex: RegExp;
      try {
        regex = new RegExp(args.filter, 'i');
      } catch {
        return toolFail(`Invalid filter regex: ${args.filter}`);
      }
      values = values.filter((value) => regex.test(value));
    }
    const limit = args.limit ?? 200;
    const unique = [...new Set(values)];
    return toolOk(
      `${unique.length} unique string(s) — showing ${Math.min(limit, unique.length)}\n${unique.slice(0, limit).join('\n')}`,
    );
  },
});

const scan = defineTool({
  name: 'rea_scan',
  title: 'Full evidence scan',
  description: 'Evidence-first scan: identity, entropy, strings, URLs, secrets, indicators, archive contents.',
  params: 'path:string',
  danger: 'safe',
  schema: z.object({ path: z.string().min(1) }),
  async run(args, ctx) {
    const file = await resolveArtifact(ctx.workspace, args.path).catch(() => null);
    if (!file) return toolFail(`Not found in workspace: ${args.path}`);
    const evidence = await buildScan(file, ctx.workspace);
    const { artifact } = evidence;
    const bullets = [
      `# REA scan · ${artifact.relative}`,
      '',
      `## Identity`,
      `type    : ${artifact.type}`,
      `size    : ${formatBytes(artifact.size)}`,
      `sha256  : ${artifact.sha256}`,
      `entropy : ${artifact.entropy} — ${evidence.entropyVerdict}`,
      '',
      `## Capability indicators`,
      evidence.indicators.length ? evidence.indicators.map((line) => `• ${line}`).join('\n') : '• none detected in the first 8 MB',
      '',
      `## Network / secrets`,
      `urls    : ${evidence.urls.length ? evidence.urls.slice(0, 12).join('\n          ') : '—'}`,
      `ips     : ${evidence.ips.length ? evidence.ips.slice(0, 10).join(', ') : '—'}`,
      `secrets : ${evidence.secrets.length ? evidence.secrets.slice(0, 6).map(stripAnsi).join('\n          ') : '—'}`,
      '',
      `## Packages / identifiers`,
      evidence.packages.length ? evidence.packages.slice(0, 15).join(', ') : '—',
    ];
    if (evidence.zipEntries.length) {
      bullets.push('', '## Archive entries (head)', evidence.zipEntries.slice(0, 25).join('\n'));
    }
    bullets.push(
      '',
      '## Notable strings (head)',
      evidence.strings
        .filter((value) => value.length >= 12)
        .slice(0, 20)
        .join('\n'),
      '',
      'Next: run rea_decompile for structural decoding, or rea_report to file this evidence.',
    );
    return toolOk(capOutput(bullets.join('\n'), 16_000), { artifact, indicators: evidence.indicators });
  },
});

const decompile = defineTool({
  name: 'rea_decompile',
  title: 'Decompile',
  description: 'Dispatch to apktool/jadx/readelf/objdump depending on the artifact type.',
  params: 'path:string, outputDir?:string, deep?:boolean',
  danger: 'write',
  schema: z.object({
    path: z.string().min(1),
    outputDir: z.string().optional(),
    deep: z.boolean().optional(),
  }),
  async run(args, ctx) {
    const file = await resolveArtifact(ctx.workspace, args.path).catch(() => null);
    if (!file) return toolFail(`Not found in workspace: ${args.path}`);
    const artifact = await inspect(file, ctx.workspace);
    const outDir = path.resolve(ctx.workspace, args.outputDir ?? `rea-out/${path.basename(file)}`);
    if (!outDir.startsWith(path.resolve(ctx.workspace))) return toolFail('Output must be inside the workspace.');
    await fsp.mkdir(outDir, { recursive: true });
    const sections: string[] = [`artifact: ${artifact.relative} (${artifact.type})`];

    if (artifact.type.includes('APK') || artifact.kind === 'dex') {
      const apktool = await hasCommand('apktool');
      const jadx = await hasCommand('jadx');
      if (apktool) {
        const result = await run('apktool', ['d', '-f', '-o', path.join(outDir, 'apktool'), file], { timeoutMs: 600_000 });
        sections.push(`apktool: ${result.code === 0 ? '✔ decoded' : `✖ ${(result.stderr || result.stdout).slice(0, 600)}`}`);
      } else {
        sections.push('apktool: missing — pkg install apktool');
      }
      if (jadx) {
        const result = await run('jadx', ['-d', path.join(outDir, 'jadx'), '--no-res', file], { timeoutMs: 900_000 });
        sections.push(`jadx: ${result.code === 0 ? '✔ decompiled' : `✖ ${(result.stderr || result.stdout).slice(0, 600)}`}`);
      } else {
        sections.push('jadx: missing — pkg install jadx');
      }
      const manifest = await hasCommand('aapt');
      if (manifest) {
        const result = await run('aapt', ['dump', 'badging', file], { timeoutMs: 30_000 });
        sections.push(`manifest: ${result.stdout.split('\n').slice(0, 12).join('\n')}`);
      }
      sections.push(`output: ${path.relative(ctx.workspace, outDir)}`);
      return toolOk(sections.join('\n\n'));
    }

    if (artifact.kind === 'elf' || artifact.kind === 'binary') {
      const readers = await firstCommand(['readelf', 'objdump']);
      if (readers === 'readelf') {
        const headers = await run('readelf', ['-h', file], { timeoutMs: 30_000 });
        const sectionsOut = await run('readelf', ['-S', file], { timeoutMs: 30_000 });
        sections.push(`# ELF header\n${headers.stdout.slice(0, 2500)}`);
        sections.push(`# Sections\n${sectionsOut.stdout.slice(0, 2500)}`);
      } else if (readers === 'objdump') {
        const headers = await run('objdump', ['-f', file], { timeoutMs: 30_000 });
        sections.push(`# objdump -f\n${headers.stdout.slice(0, 2500)}`);
      } else {
        sections.push('readelf/objdump: missing — pkg install binutils');
      }
      if (await hasCommand('objdump') && args.deep) {
        const disasm = await run('objdump', ['-d', '--no-show-raw-insn', file], { timeoutMs: 180_000 });
        sections.push(`# disassembly (head)\n${disasm.stdout.slice(0, 4000)}`);
      }
      return toolOk(sections.join('\n\n'));
    }

    if (artifact.kind === 'script' || artifact.kind === 'text') {
      sections.push('Text/script artifact — use rea_analyze_js for behavioral summary, or read it directly.');
      return toolOk(sections.join('\n\n'));
    }

    if (artifact.kind === 'zip') {
      const listing = await listZip(file);
      sections.push(`# archive entries\n${listing.slice(0, 60).join('\n')}`);
      return toolOk(sections.join('\n\n'));
    }

    sections.push('No decompiler path for this type. Use rea_strings / rea_scan for evidence.');
    return toolOk(sections.join('\n\n'));
  },
});

const analyzeJs = defineTool({
  name: 'rea_analyze_js',
  title: 'Analyze JS/TS',
  description: 'Static summary of a JavaScript bundle: imports, endpoints, secrets, dangerous APIs.',
  params: 'path:string',
  danger: 'safe',
  schema: z.object({ path: z.string().min(1) }),
  async run(args, ctx) {
    const file = await resolveArtifact(ctx.workspace, args.path).catch(() => null);
    if (!file) return toolFail(`Not found in workspace: ${args.path}`);
    const content = await fsp.readFile(file, 'utf8').catch(() => '');
    if (!content) return toolFail('Could not read the file as UTF-8.');
    const imports = [...new Set([...content.matchAll(/(?:require\(|from\s+)["']([^"']+)["']/g)].map((match) => match[1] ?? '').filter(Boolean))];
    const endpoints = [...new Set([...content.matchAll(/https?:\/\/[^\s"'`)<>]+/g)].map((match) => match[0]))].slice(0, 40);
    const dangerous = [
      [/\beval\s*\(/, 'eval()'],
      [/\bnew\s+Function\s*\(/, 'new Function()'],
      [/\bchild_process\b/, 'child_process'],
      [/\bexecSync\s*\(/, 'execSync()'],
      [/\bprocess\.env\b/, 'env access'],
      [/\bdocument\.cookie\b/, 'document.cookie'],
      [/\blocalStorage\b/, 'localStorage'],
      [/\bcrypto\.subtle\b/, 'WebCrypto'],
    ].filter(([pattern]) => (pattern as RegExp).test(content)).map(([, label]) => label as string);
    const secretish = [...new Set([...content.matchAll(/(?:api[_-]?key|token|secret|password)["'\s:=]+([A-Za-z0-9_\-]{12,})/gi)].map((match) => `${match[0]?.slice(0, 24)}…`))].slice(0, 10);
    return toolOk(
      [
        `file      : ${path.relative(ctx.workspace, file)} (${formatBytes(Buffer.byteLength(content))})`,
        `lines     : ${content.split('\n').length}`,
        `imports   : ${imports.slice(0, 25).join(', ') || '—'}`,
        `endpoints : ${endpoints.slice(0, 15).join('\n            ') || '—'}`,
        `dangerous : ${dangerous.join(', ') || '—'}`,
        `secrets   : ${secretish.join(', ') || '—'}`,
      ].join('\n'),
    );
  },
});

const report = defineTool({
  name: 'rea_report',
  title: 'Write report',
  description: 'Write a Markdown evidence report for an artifact into ~/.ai-freebuff/reports.',
  params: 'path:string, title?:string',
  danger: 'write',
  schema: z.object({ path: z.string().min(1), title: z.string().optional() }),
  async run(args, ctx) {
    const file = await resolveArtifact(ctx.workspace, args.path).catch(() => null);
    if (!file) return toolFail(`Not found in workspace: ${args.path}`);
    const evidence = cache.get(file) ?? (await buildScan(file, ctx.workspace));
    const { artifact } = evidence;
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const target = path.join(ctx.home, 'reports', `rea-${path.basename(file)}-${stamp}.md`);
    await fsp.mkdir(path.dirname(target), { recursive: true });
    const markdown = [
      `# REA report — ${args.title ?? artifact.relative}`,
      '',
      `- Generated: ${new Date().toISOString()}`,
      `- Artifact: \`${artifact.relative}\``,
      `- Type: ${artifact.type}`,
      `- Size: ${formatBytes(artifact.size)}`,
      `- SHA-256: \`${artifact.sha256}\``,
      `- Entropy: ${artifact.entropy} bits/byte (${evidence.entropyVerdict})`,
      '',
      '## Observed facts',
      `- Capability indicators: ${evidence.indicators.join(', ') || 'none'}`,
      `- URLs: ${evidence.urls.length}`,
      `- IPs: ${evidence.ips.length}`,
      `- Secret-like strings: ${evidence.secrets.length}`,
      `- Package identifiers: ${evidence.packages.length}`,
      '',
      '## Network indicators',
      ...(evidence.urls.length ? evidence.urls.map((url) => `- ${url}`) : ['- none']),
      '',
      '## Package identifiers',
      ...(evidence.packages.length ? evidence.packages.slice(0, 40).map((pkg) => `- \`${pkg}\``) : ['- none']),
      '',
      '## Hypotheses (unverified)',
      evidence.indicators.length
        ? evidence.indicators.map((indicator) => `- ${indicator} — confirm by inspecting the relevant code path.`)
        : ['- No strong hypotheses from static evidence alone.'],
      '',
      '## Next steps',
      '1. `rea_decompile` to decode structure.',
      '2. Diff decoded sources against expected behavior.',
      '3. Only then treat dynamic findings as confirmed.',
      '',
      '---',
      'Generated by AI-FREEBUFF MCP · REA methodology (https://github.com/morluto/rea)',
      '',
    ].join('\n');
    await fsp.writeFile(target, markdown, 'utf8');
    return toolOk(`✔ report written: ${target}`);
  },
});

export const reaMcp: McpModule = {
  id: 'rea',
  name: 'MCP Reverse Engineer Anything',
  blurb: 'Evidence-first artifact analysis, decompilation and reporting.',
  version: '1.0.0',
  tools: [capabilities, detect, stringsTool, scan, decompile, analyzeJs, report],
  async probe() {
    const have = await Promise.all(['unzip', 'apktool', 'jadx', 'readelf'].map(async (binary) => [binary, await hasCommand(binary)] as const));
    const ready = have.filter(([, present]) => present).map(([binary]) => binary);
    return ready.length >= 2
      ? { status: 'ready', detail: `tools: ${ready.join(', ')}` }
      : { status: 'degraded', detail: 'limited toolchain — pkg install apktool jadx binutils' };
  },
};
