import type { ChatMessage } from './model-router';
import { isProbablyThai, oneLine } from '../utils/text';

/**
 * Offline planner.
 *
 * This is what runs when no model API key is configured (or a provider is
 * unreachable). It is deliberately *not* pretending to be an LLM: it is a
 * transparent, rule-based dispatcher that still lets you drive every tool, read
 * results and operate the app on a plane with no network.
 *
 * Thai and English phrasings are both matched.
 */

export interface OfflineToolCall {
  name: string;
  args: Record<string, unknown>;
}

export interface OfflinePlan {
  text: string;
  toolCall?: OfflineToolCall;
}

const RESULT_TAG = '<tool_result';

function stripTag(content: string): { name: string; ok: boolean; body: string } {
  const name = /name="([^"]+)"/.exec(content)?.[1] ?? 'tool';
  const ok = /ok="(true|false)"/.exec(content)?.[1] === 'true';
  const body = content.replace(/^<tool_result[^>]*>/, '').replace(/<\/tool_result>\s*$/, '').trim();
  return { name, ok, body };
}

function summarizeResult(content: string): OfflinePlan {
  const { name, ok, body } = stripTag(content);
  const clipped = body.length > 2200 ? `${body.slice(0, 2200)}\n… (ตัดข้อความยาว)` : body;
  if (!ok) {
    return {
      text:
        `⚠ ${name} ไม่สำเร็จ / failed\n\n${clipped}\n\n` +
        'แก้ตามคำแนะนำข้างบนแล้วสั่งใหม่ได้เลย — เช่นติดตั้งแพ็กเกจที่ขาด หรือแก้ path ให้ถูก\n' +
        'Fix the cause above and re-run. Type "help" to see what I can do.',
    };
  }
  return {
    text:
      `✔ ${name} ทำงานเสร็จแล้ว\n\n${clipped || '(ไม่มี output)'}\n\n` +
      'ต้องการให้ทำอะไรต่อ พิมพ์มาได้เลย (หรือตั้ง API key เพื่อปลดล็อกการวางแผนแบบ LLM เต็มรูปแบบ)',
  };
}

function extractPath(input: string): string | undefined {
  const quoted = /["'`]([^"'`\n]{2,200})["'`]/.exec(input);
  if (quoted?.[1]) return quoted[1];
  const candidate = /(?:^|\s)((?:\.{0,2}\/)?[\w@.-]+(?:\/[\w@.-]+)*\.[A-Za-z0-9]{1,8})(?:\s|$)/.exec(input);
  return candidate?.[1];
}

function extractWord(input: string, patterns: RegExp[]): string | undefined {
  for (const pattern of patterns) {
    const match = pattern.exec(input);
    if (match?.[1]) return match[1];
  }
  return undefined;
}

function has(tools: string[], name: string): boolean {
  return tools.includes(name);
}

function pick(tools: string[], name: string, args: Record<string, unknown>): OfflinePlan {
  return {
    text: `ใช้เครื่องมือ ${name} ให้ก่อน แล้วจะสรุปผลให้`,
    toolCall: has(tools, name) ? { name, args } : undefined,
  };
}

const HELP_EN = `I'm running in **offline planner** mode — no API key is configured, so I can't reason freely yet.

What still works right now (deterministic tool routing):
• "scan ./app.apk"              → reverse-engineering scan (REA)
• "read src/index.tsx"          → file reader
• "list files"                  → workspace listing
• "create a godot project neon" → Godot scaffold
• "github torvalds/linux"       → repo summary
• "android devices"             → adb devices
• "battery" / "wifi"            → Termux:API
• "status"                      → environment report

To unlock full natural-language reasoning (Thai included):
  export OPENAI_API_KEY=sk-...
  # or ANTHROPIC_API_KEY / GROQ_API_KEY / OPENROUTER_API_KEY
  # or run Ollama locally and set AI_FREEBUFF_BASE_URL=http://127.0.0.1:11434/v1`;

const HELP_TH = `ตอนนี้รันโหมด **offline planner** — ยังไม่ได้ตั้ง API key จึงยังคิดวิเคราะห์แบบ LLM เต็มรูปแบบไม่ได้

สิ่งที่ใช้ได้ทันที:
• "สแกน ./app.apk"        → วิเคราะห์ไฟล์แบบ REA
• "อ่านไฟล์ src/index.tsx" → อ่านไฟล์
• "ดูไฟล์"                 → รายการในเวิร์กสเปซ
• "สร้างโปรเจกต์ godot neon" → สร้างโครงโปรเจกต์ Godot
• "github torvalds/linux"  → สรุป repo
• "มือถือ" / "adb"          → ตรวจอุปกรณ์
• "แบต" / "wifi"            → Termux:API
• "สถานะ"                  → รายงานสภาพแวดล้อม

ปลดล็อกโหมดเต็ม:
  export OPENAI_API_KEY=sk-...
  # หรือ ANTHROPIC_API_KEY / GROQ_API_KEY / OPENROUTER_API_KEY
  # หรือรัน Ollama แล้วตั้ง AI_FREEBUFF_BASE_URL=http://127.0.0.1:11434/v1`;

function intro(thai: boolean): string {
  return thai
    ? `สวัสดีครับ ผม AI-FREEBUFF — เอเจนต์บน Termux ที่มี 9 MCP และ 4 สกิล\n\nพิมพ์คำสั่งเป็นภาษาธรรมชาติได้เลย เช่น "สแกนไฟล์ ./app.apk" หรือ "สร้างโปรเจกต์ godot"\nพิมพ์ "help" เพื่อดูความสามารถทั้งหมด`
    : `Hello — I'm AI-FREEBUFF, a Termux agent with 9 MCP servers and 4 skills.\n\nAsk in plain language: "scan ./app.apk", "read src/index.tsx", "create a godot project".\nType "help" for the full capability list.`;
}

export function planOffline(messages: ChatMessage[], tools: string[]): OfflinePlan {
  const last = messages[messages.length - 1];
  if (!last) return { text: intro(true) };

  if (last.role === 'user' && last.content.trimStart().startsWith(RESULT_TAG)) {
    return summarizeResult(last.content);
  }

  const input = last.content.trim();
  const lower = input.toLowerCase();
  const thai = isProbablyThai(input);
  const pathArg = extractPath(input);

  if (input === '' ) return { text: intro(thai) };

  if (/^(hi|hello|hey|yo|สวัสดี|หวัดดี|ดีจ้า|ดีครับ|ดีค่ะ)\b/i.test(input) || /^(hi|hello)$/i.test(lower)) {
    return { text: intro(thai) };
  }

  if (/(help|ความสามารถ|ช่วย|คำสั่ง|what can you do|how to|วิธีใช้)/i.test(lower)) {
    return { text: thai ? HELP_TH : HELP_EN };
  }

  // ---- skills -----------------------------------------------------------
  const installVerb = /(ติดตั้ง|ลง|เพิ่ม|install|add|setup|set up|enable)/i.test(lower);
  const mentionsSkill = /(skill|สกิล|ทักษะ)/i.test(lower);
  if (installVerb && mentionsSkill) {
    const known = /(unslop|ui-ux-pro-max|superpowers|openai\s*\/?\s*skills|anthropic)/i.exec(lower)?.[0];
    if (known) {
      return pick(tools, 'skill_install', { slug: known.replace(/\s+/g, '-').replace('openai-skills', 'openai-skills') });
    }
    const name = extractWord(input, [/skill\s+([\w./-]+)/i, /สกิล\s+([\w./-]+)/i]);
    if (name) return pick(tools, 'skill_install', { slug: name });
    return {
      text: thai
        ? 'จะติดตั้งสกิลไหนครับ? ที่มีมาให้แล้ว: unslop, ui-ux-pro-max, superpowers, openai-skills\nพิมพ์ชื่อสกิลหรือ GitHub URL ได้เลย'
        : 'Which skill? Bundled: unslop, ui-ux-pro-max, superpowers, openai-skills.\nGive a name or a GitHub URL.',
    };
  }

  if (/(list|แสดง|ดู|รายการ).*(skill|สกิล)/i.test(lower)) {
    return pick(tools, 'skill_list', {});
  }

  // ---- MCP install ------------------------------------------------------
  if (installVerb && /\bmcp\b/i.test(lower)) {
    const name = extractWord(input, [/\bmcp\s+([\w@./-]+)/i]);
    const url = /(https?:\/\/\S+|[\w-]+\/[\w-]+)/.exec(input)?.[1];
    if (name || url) return pick(tools, 'mcp_install', { name: name ?? url, source: url ?? name });
    return {
      text: thai
        ? 'บอกชื่อ MCP หรือ source ที่จะติดตั้งด้วยครับ เช่น "ติดตั้ง mcp filesystem จาก @modelcontextprotocol/server-filesystem"'
        : 'Tell me the MCP name and source, e.g. "install mcp @modelcontextprotocol/server-filesystem".',
    };
  }

  // ---- Godot ------------------------------------------------------------
  if (/\bgodot\b/i.test(lower)) {
    if (/(สร้าง|create|new|scaffold|เริ่ม|init)/i.test(lower)) {
      const name = extractWord(input, [/godot[^"\n]*?(?:ชื่อ|named|called)\s+([\w -]{2,40})/i]) ?? extractWord(input, [/godot\s+(?:project\s+)?([\w-]{2,40})/i]) ?? 'neon-project';
      const template = /\b3d\b/i.test(lower) ? '3d' : /\bui\b/i.test(lower) ? 'ui' : '2d';
      return pick(tools, 'godot_project_create', { name: name.replace(/[^\w -]/g, '').trim() || 'neon-project', template });
    }
    return pick(tools, 'godot_info', {});
  }

  // ---- GitHub -----------------------------------------------------------
  if (/github|gh repo/i.test(lower)) {
    const repo = extractWord(input, [/([\w.-]+\/[\w.-]+)/]);
    if (repo && !repo.startsWith('http')) return pick(tools, 'github_repo', { repo });
    return pick(tools, 'github_user', {});
  }

  // ---- Reverse engineering ---------------------------------------------
  if (/(rea|reverse|decompile|disassemble|สแกน|วิเคราะห์ไฟล์|ถอดรหัส)/i.test(lower)) {
    if (!pathArg) {
      return {
        text: thai
          ? 'ระบุไฟล์ที่ต้องการวิเคราะห์ด้วยครับ เช่น "สแกน ./app.apk" หรือ "วิเคราะห์ ./libnative.so"'
          : 'Point me at an artifact, e.g. "scan ./app.apk" or "analyze ./libnative.so".',
      };
    }
    return pick(tools, 'rea_scan', { path: pathArg });
  }

  // ---- Files ------------------------------------------------------------
  if (/(อ่าน|read|cat|open|ดูเนื้อหา)/i.test(lower) && pathArg) {
    return pick(tools, 'file_read', { path: pathArg });
  }
  if (/(list|ls|ดูไฟล์|รายการไฟล์|โฟลเดอร์)/i.test(lower)) {
    return pick(tools, 'file_list', { path: pathArg ?? '.', depth: 1 });
  }
  if (/(ค้นหา|grep|search).*(ในไฟล์|code|โค้ด)/i.test(lower)) {
    const needle = extractWord(input, [/(?:ค้นหา|grep|search)\s+["']?([^"'\n]{2,60})/i]);
    if (needle) return pick(tools, 'file_search', { pattern: needle });
  }

  // ---- Android / Termux -------------------------------------------------
  if (/(adb|android|มือถือ|โทรศัพท์|device)/i.test(lower)) {
    if (/(screenshot|แคป|จอภาพ)/i.test(lower)) return pick(tools, 'android_screenshot', {});
    if (/(package|แอป|app)/i.test(lower)) return pick(tools, 'android_packages', {});
    return pick(tools, 'android_devices', {});
  }
  if (/(battery|แบต)/i.test(lower)) return pick(tools, 'termux_battery', {});
  if (/(wifi|ไวไฟ|wi-fi)/i.test(lower)) return pick(tools, 'termux_wifi', {});
  if (/(notify|notification|แจ้งเตือน)/i.test(lower)) {
    return pick(tools, 'termux_notification', { content: input.slice(0, 200), title: 'AI-FREEBUFF' });
  }
  if (/(พูด|speak|tts|อ่านออกเสียง)/i.test(lower)) {
    const text = input.replace(/^(พูด|speak|tts|อ่านออกเสียง)\s*[:：]?\s*/i, '');
    return pick(tools, 'termux_tts', { text: text || 'สวัสดีจาก AI-FREEBUFF' });
  }
  if (/(clipboard|คลิปบอร์ด|คัดลอก)/i.test(lower)) {
    if (pathArg || /(วาง|set|copy|คัดลอก)/i.test(lower)) {
      return pick(tools, 'termux_clipboard_set', { text: input });
    }
    return pick(tools, 'termux_clipboard_get', {});
  }

  // ---- Environment ------------------------------------------------------
  if (/(status|สถานะ|ระบบ|system info|info|doctor)/i.test(lower)) {
    return pick(tools, 'sys_info', {});
  }

  if (/(model|โมเดล|provider)/i.test(lower)) {
    return pick(tools, 'model_info', {});
  }

  // ---- Fallback ---------------------------------------------------------
  const sample = oneLine(input, 120);
  return {
    text: thai
      ? `ผมยังไม่เข้าใจ "${sample}" ในโหมด offline planner ครับ\n\n` +
        'ลองใช้คำสั่งที่ชัดเจน เช่น "สแกน ./app.apk", "อ่านไฟล์ README.md", "สร้างโปรเจกต์ godot neon"\n' +
        'หรือตั้ง API key (OPENAI_API_KEY / ANTHROPIC_API_KEY / GROQ_API_KEY) เพื่อให้ผมเข้าใจภาษาธรรมชาติได้เต็มรูปแบบ\n\n' +
        'พิมพ์ "help" เพื่อดูทั้งหมด'
      : `I can't interpret "${sample}" in offline planner mode.\n\n` +
        'Try a concrete command: "scan ./app.apk", "read README.md", "create godot project neon".\n' +
        'Or export an API key (OPENAI_API_KEY / ANTHROPIC_API_KEY / GROQ_API_KEY) to unlock full natural-language reasoning.\n\n' +
        'Type "help" for the list.',
  };
}
