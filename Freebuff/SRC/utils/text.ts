/** Text utilities: all pure functions, no Ink/React dependencies. */

const ANSI_PATTERN = /\u001B\[[0-9;]*m/g;

export function stripAnsi(input: string): string {
  return input.replace(ANSI_PATTERN, '');
}

/** Visible length, ignoring ANSI escapes. */
export function visibleLength(input: string): number {
  return [...stripAnsi(input)].length;
}

/** Truncate by visible length with an ellipsis. */
export function truncate(input: string, max: number, ellipsis = '…'): string {
  const chars = [...stripAnsi(input)];
  if (chars.length <= max) return input;
  if (max <= 1) return ellipsis;
  return chars.slice(0, max - 1).join('') + ellipsis;
}

/** Truncate to a single line (for status bars and tables). */
export function oneLine(input: string, max = 120): string {
  return truncate(input.replace(/\s+/g, ' ').trim(), max);
}

export function padEnd(input: string, width: number): string {
  const length = visibleLength(input);
  return length >= width ? input : input + ' '.repeat(width - length);
}

export function padStart(input: string, width: number): string {
  const length = visibleLength(input);
  return length >= width ? input : ' '.repeat(width - length) + input;
}

/** Byte-size formatting for tool output footers. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const index = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const value = bytes / Math.pow(1024, index);
  return `${value >= 10 || index === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[index]}`;
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes}m ${seconds}s`;
}

export function formatTime(date = new Date()): string {
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/** Word-wrap that respects explicit newlines and never splits words oddly. */
export function wrapText(input: string, width: number): string[] {
  const safeWidth = Math.max(10, width);
  const output: string[] = [];
  for (const rawLine of input.split('\n')) {
    if (visibleLength(rawLine) <= safeWidth) {
      output.push(rawLine);
      continue;
    }
    let current = '';
    for (const word of rawLine.split(/(\s+)/)) {
      if (word === '') continue;
      if (visibleLength(current + word) > safeWidth && current.trim() !== '') {
        output.push(current.trimEnd());
        current = word.trimStart();
      } else {
        current += word;
      }
    }
    if (current !== '') output.push(current.trimEnd());
  }
  return output;
}

/** Cap a tool result so a single chatty command cannot flood the transcript. */
export function capOutput(input: string, maxChars = 12_000): string {
  if (input.length <= maxChars) return input;
  const head = input.slice(0, Math.floor(maxChars * 0.7));
  const tail = input.slice(-Math.floor(maxChars * 0.2));
  return `${head}\n\n… [${input.length - head.length - tail.length} chars elided] …\n\n${tail}`;
}

/** Very small HTML -> text conversion for the Playwright fallback reader. */
export function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|section|article|li|h[1-6]|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n\s*\n+/g, '\n\n')
    .trim();
}

/** Extract readable text plus link targets from a page. */
export function extractLinks(html: string, limit = 40): string[] {
  const links: string[] = [];
  const re = /<a\b[^>]*href=["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(html)) !== null && links.length < limit) {
    const href = (match[1] || '').trim();
    const label = htmlToText(match[2] || '').trim();
    if (!href || href.startsWith('javascript:')) continue;
    links.push(label ? `${label} -> ${href}` : href);
  }
  return links;
}

export function isProbablyThai(input: string): boolean {
  return /[\u0E00-\u0E7F]/.test(input);
}

export function ellipsizeMiddle(input: string, max: number): string {
  if (input.length <= max) return input;
  const half = Math.floor((max - 1) / 2);
  return `${input.slice(0, half)}…${input.slice(-half)}`;
}
