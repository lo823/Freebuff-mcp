import fsp from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { hasCommand } from '../utils/shell';
import { capOutput, extractLinks, htmlToText } from '../utils/text';
import { defineTool, toolFail, toolOk, type McpModule } from './types';

/**
 * MCP Playwright — browser automation.
 *
 * On Termux there is no officially supported Chromium build, so this server
 * supports three modes, in order:
 *   1. `playwright` installed locally (works in proot-distro / Ubuntu chroot),
 *   2. a remote browser over CDP (`PLAYWRIGHT_CDP_URL=ws://…` from a desktop),
 *   3. a dependency-free HTTP + HTML→text fallback.
 *
 * Tools never lie about which mode produced their output.
 */

type Engine = 'playwright' | 'cdp' | 'fetch' | 'none';

interface BrowserSession {
  engine: Engine;
  browser?: any;
  context?: any;
  page?: any;
  lastUrl?: string;
  lastHtml?: string;
  lastTitle?: string;
}

const session: BrowserSession = { engine: 'none' };
const PLAYWRIGHT_SPECS = ['playwright', 'playwright-core'];

async function loadPlaywright(): Promise<any | null> {
  for (const spec of PLAYWRIGHT_SPECS) {
    try {
      // Non-literal specifier: the module is optional, so TS must not resolve it.
      const loaded: any = await import(spec);
      return loaded?.chromium ? loaded : loaded?.default ?? loaded;
    } catch {
      /* try the next one */
    }
  }
  return null;
}

async function ensureBrowser(): Promise<{ ok: boolean; error?: string }> {
  if (session.engine === 'playwright' || session.engine === 'cdp') {
    if (session.page) return { ok: true };
  }
  const playwright = await loadPlaywright();
  if (!playwright?.chromium) {
    session.engine = 'fetch';
    return {
      ok: false,
      error:
        'Playwright is not installed — running in HTTP fallback mode.\n' +
        'Full browser control options:\n' +
        '• PC/desktop: npm i -D playwright && npx playwright install chromium, then set PLAYWRIGHT_CDP_URL=ws://<pc>:9222/devtools/browser/<id>\n' +
        '• proot-distro: pkg install proot-distro && proot-distro install ubuntu, then npm i playwright inside it\n' +
        'The HTTP fallback still supports pw_open, pw_text and pw_links.',
    };
  }
  try {
    const cdpUrl = process.env.PLAYWRIGHT_CDP_URL;
    if (cdpUrl) {
      const browser = await playwright.chromium.connectOverCDP(cdpUrl);
      session.browser = browser;
      session.context = browser.contexts()[0] ?? (await browser.newContext());
      session.page = await session.context.newPage();
      session.engine = 'cdp';
      return { ok: true };
    }
    const browser = await playwright.chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
    });
    session.browser = browser;
    session.context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    session.page = await session.context.newPage();
    session.engine = 'playwright';
    return { ok: true };
  } catch (error) {
    session.engine = 'fetch';
    return {
      ok: false,
      error:
        `Chromium could not start: ${(error as Error).message}\n` +
        'Install browsers with `npx playwright install chromium`, or use the HTTP fallback tools.',
    };
  }
}

async function fetchPage(url: string): Promise<{ html: string; title: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25_000);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: {
        'user-agent': 'Mozilla/5.0 (Linux; Android 14; Termux) AppleWebKit/537.36 AI-FREEBUFF/1.0',
        accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
      },
    });
    const html = await response.text();
    if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
    const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]?.trim() ?? '';
    return { html, title };
  } finally {
    clearTimeout(timer);
  }
}

function normalizeUrl(input: string): string {
  if (/^https?:\/\//i.test(input)) return input;
  if (/^[\w.-]+\.[a-z]{2,}(\/|$)/i.test(input)) return `https://${input}`;
  return input;
}

const status = defineTool({
  name: 'pw_status',
  title: 'Browser status',
  description: 'Report the active browser engine and how to upgrade it.',
  params: '(no arguments)',
  danger: 'safe',
  schema: z.object({}),
  async run() {
    const playwright = await loadPlaywright();
    const chromium = await hasCommand('chromium') || await hasCommand('chromium-browser') || await hasCommand('google-chrome');
    return toolOk(
      [
        `engine        : ${session.engine}`,
        `playwright pkg: ${playwright ? 'installed' : 'not installed'}`,
        `chromium bin  : ${chromium ? 'found' : 'not found'}`,
        `CDP endpoint  : ${process.env.PLAYWRIGHT_CDP_URL ?? '(none)'}`,
        `current url   : ${session.lastUrl ?? '—'}`,
        '',
        'Upgrade path: npm i -D playwright && npx playwright install chromium',
        'Termux arm64: use a remote browser via PLAYWRIGHT_CDP_URL, or run this inside proot-distro Ubuntu.',
      ].join('\n'),
    );
  },
});

const open = defineTool({
  name: 'pw_open',
  title: 'Open URL',
  description: 'Navigate to a URL (launching a headless browser when available).',
  params: 'url:string, waitMs?:number',
  danger: 'safe',
  schema: z.object({ url: z.string().min(3), waitMs: z.number().int().min(0).max(30_000).optional() }),
  async run(args) {
    const url = normalizeUrl(args.url);
    const browser = await ensureBrowser();
    if (browser.ok && session.page) {
      try {
        const response = await session.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
        if (args.waitMs) await session.page.waitForTimeout(args.waitMs);
        session.lastUrl = session.page.url();
        session.lastTitle = await session.page.title().catch(() => '');
        return toolOk(
          `✔ ${session.lastUrl}\ntitle  : ${session.lastTitle}\nstatus : ${response?.status() ?? 'n/a'}\nengine : ${session.engine}`,
        );
      } catch (error) {
        return toolFail(`Navigation failed: ${(error as Error).message}`);
      }
    }
    try {
      const page = await fetchPage(url);
      session.lastUrl = url;
      session.lastHtml = page.html;
      session.lastTitle = page.title;
      return toolOk(`✔ ${url}\ntitle  : ${page.title || '—'}\nbytes  : ${page.html.length}\nengine : fetch fallback (no JavaScript)`);
    } catch (error) {
      return toolFail(`${(error as Error).message}\n\n${browser.error ?? ''}`);
    }
  },
});

const text = defineTool({
  name: 'pw_text',
  title: 'Extract text',
  description: 'Read the visible text of the page, or of a CSS selector.',
  params: 'selector?:string, limit?:number',
  danger: 'safe',
  schema: z.object({ selector: z.string().optional(), limit: z.number().int().min(100).max(40_000).optional() }),
  async run(args) {
    const browser = await ensureBrowser();
    if (browser.ok && session.page) {
      if (!session.lastUrl) return toolFail('No page open. Use pw_open first.');
      try {
        const value = args.selector
          ? await session.page.locator(args.selector).first().innerText({ timeout: 10_000 })
          : await session.page.evaluate(() => document.body?.innerText ?? '');
        return toolOk(capOutput(String(value).trim() || '(empty)', args.limit ?? 12_000));
      } catch (error) {
        return toolFail(`Extraction failed: ${(error as Error).message}`);
      }
    }
    if (!session.lastHtml) return toolFail('No page loaded. Use pw_open first.');
    if (args.selector) return toolFail('CSS selectors need a real browser. Use pw_open + pw_text without a selector.');
    return toolOk(capOutput(htmlToText(session.lastHtml), args.limit ?? 12_000));
  },
});

const links = defineTool({
  name: 'pw_links',
  title: 'List links',
  description: 'List anchors on the current page.',
  params: 'limit?:number',
  danger: 'safe',
  schema: z.object({ limit: z.number().int().min(1).max(300).optional() }),
  async run(args) {
    const browser = await ensureBrowser();
    if (browser.ok && session.page) {
      try {
        const items: Array<{ text: string; href: string }> = await session.page.evaluate(() =>
          Array.from(document.querySelectorAll('a[href]')).map((anchor) => ({
            text: (anchor.textContent ?? '').trim().slice(0, 80),
            href: (anchor as HTMLAnchorElement).href,
          })),
        );
        return toolOk(items.slice(0, args.limit ?? 40).map((item) => `${item.text || '(no text)'} -> ${item.href}`).join('\n') || '(no links)');
      } catch (error) {
        return toolFail((error as Error).message);
      }
    }
    if (!session.lastHtml) return toolFail('No page loaded. Use pw_open first.');
    return toolOk(extractLinks(session.lastHtml, args.limit ?? 40).join('\n') || '(no links)');
  },
});

const screenshot = defineTool({
  name: 'pw_screenshot',
  title: 'Screenshot page',
  description: 'Capture a PNG of the page (requires a real browser).',
  params: 'file?:string, fullPage?:boolean',
  danger: 'write',
  schema: z.object({ file: z.string().optional(), fullPage: z.boolean().optional() }),
  async run(args, ctx) {
    const browser = await ensureBrowser();
    if (!browser.ok || !session.page) {
      return toolFail(`Screenshot needs Playwright.\n${browser.error ?? ''}`);
    }
    const target = path.resolve(ctx.workspace, args.file ?? 'page.png');
    if (!target.startsWith(path.resolve(ctx.workspace))) return toolFail('Output must be inside the workspace.');
    await fsp.mkdir(path.dirname(target), { recursive: true });
    try {
      await session.page.screenshot({ path: target, fullPage: args.fullPage ?? true });
      const stat = await fsp.stat(target);
      return toolOk(`✔ screenshot ${(stat.size / 1024).toFixed(0)} KB → ${path.relative(ctx.workspace, target)}`);
    } catch (error) {
      return toolFail(`Screenshot failed: ${(error as Error).message}`);
    }
  },
});

const click = defineTool({
  name: 'pw_click',
  title: 'Click element',
  description: 'Click the first element matching a CSS selector.',
  params: 'selector:string',
  danger: 'write',
  schema: z.object({ selector: z.string().min(1) }),
  async run(args) {
    const browser = await ensureBrowser();
    if (!browser.ok || !session.page) return toolFail(`Clicking needs Playwright.\n${browser.error ?? ''}`);
    try {
      await session.page.locator(args.selector).first().click({ timeout: 15_000 });
      return toolOk(`✔ clicked ${args.selector} → ${session.page.url()}`);
    } catch (error) {
      return toolFail(`Click failed: ${(error as Error).message}`);
    }
  },
});

const type = defineTool({
  name: 'pw_type',
  title: 'Type into field',
  description: 'Fill a field and optionally press Enter.',
  params: 'selector:string, text:string, submit?:boolean',
  danger: 'write',
  schema: z.object({ selector: z.string().min(1), text: z.string(), submit: z.boolean().optional() }),
  async run(args) {
    const browser = await ensureBrowser();
    if (!browser.ok || !session.page) return toolFail(`Typing needs Playwright.\n${browser.error ?? ''}`);
    try {
      await session.page.locator(args.selector).first().fill(args.text, { timeout: 15_000 });
      if (args.submit) {
        await session.page.keyboard.press('Enter');
        await session.page.waitForLoadState('domcontentloaded').catch(() => undefined);
      }
      return toolOk(`✔ typed into ${args.selector}${args.submit ? ' and submitted' : ''}`);
    } catch (error) {
      return toolFail(`Type failed: ${(error as Error).message}`);
    }
  },
});

const evalJs = defineTool({
  name: 'pw_eval',
  title: 'Evaluate JS',
  description: 'Evaluate a JavaScript expression inside the page and return the result.',
  params: 'expression:string',
  danger: 'dangerous',
  schema: z.object({ expression: z.string().min(1) }),
  async run(args) {
    const browser = await ensureBrowser();
    if (!browser.ok || !session.page) return toolFail(`Evaluation needs Playwright.\n${browser.error ?? ''}`);
    try {
      const result = await session.page.evaluate(args.expression);
      return toolOk(typeof result === 'string' ? result : JSON.stringify(result, null, 2));
    } catch (error) {
      return toolFail(`Evaluation failed: ${(error as Error).message}`);
    }
  },
});

const pdf = defineTool({
  name: 'pw_pdf',
  title: 'Print PDF',
  description: 'Render the current page to PDF (Chromium only).',
  params: 'file?:string',
  danger: 'write',
  schema: z.object({ file: z.string().optional() }),
  async run(args, ctx) {
    const browser = await ensureBrowser();
    if (!browser.ok || !session.page) return toolFail(`PDF export needs Playwright.\n${browser.error ?? ''}`);
    const target = path.resolve(ctx.workspace, args.file ?? 'page.pdf');
    if (!target.startsWith(path.resolve(ctx.workspace))) return toolFail('Output must be inside the workspace.');
    try {
      await session.page.pdf({ path: target, format: 'A4', printBackground: true });
      return toolOk(`✔ PDF → ${path.relative(ctx.workspace, target)}`);
    } catch (error) {
      return toolFail(`PDF failed: ${(error as Error).message}`);
    }
  },
});

const close = defineTool({
  name: 'pw_close',
  title: 'Close browser',
  description: 'Close the browser session and free memory.',
  params: '(no arguments)',
  danger: 'safe',
  schema: z.object({}),
  async run() {
    try {
      await session.browser?.close?.();
    } catch {
      /* already gone */
    }
    session.browser = undefined;
    session.context = undefined;
    session.page = undefined;
    session.engine = 'none';
    session.lastUrl = undefined;
    session.lastHtml = undefined;
    return toolOk('✔ browser closed');
  },
});

export const playwrightMcp: McpModule = {
  id: 'playwright',
  name: 'MCP Playwright',
  blurb: 'Headless browser automation with an HTTP fallback.',
  version: '1.0.0',
  tools: [status, open, text, links, screenshot, click, type, evalJs, pdf, close],
  async probe() {
    const playwright = await loadPlaywright();
    if (playwright) return { status: 'ready', detail: process.env.PLAYWRIGHT_CDP_URL ? 'remote CDP browser' : 'playwright installed' };
    return { status: 'degraded', detail: 'playwright missing — HTTP fallback only' };
  },
  async dispose() {
    try {
      await session.browser?.close?.();
    } catch {
      /* ignore */
    }
  },
};
