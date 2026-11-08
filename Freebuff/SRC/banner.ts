/**
 * ASCII art generator for the launch banner.
 *
 * Only block characters are used (█ ▀ ▄ ╔ ═ ╗ …) so the art renders
 * identically in every Termux font, with or without a Nerd Font.
 * Two sizes are provided: the full 5-row wordmark and a 3-row compact
 * version for narrow phone screens.
 */

export const BANNER_TEXT = 'FREEBUFF MCP';

export const TAGLINE = 'agentic terminal · 9 mcp servers · 4 skills';

export const SUBTITLE = 'TERMUX // NEON CORE // BUILD 1.0.0';

/** Full-size 5-row wordmark. */
const BIG_GLYPHS: Record<string, string[]> = {
  F: ['█████', '█    ', '████ ', '█    ', '█    '],
  R: ['████ ', '█   █', '████ ', '█  █ ', '█   █'],
  E: ['█████', '█    ', '████ ', '█    ', '█████'],
  B: ['████ ', '█   █', '████ ', '█   █', '████ '],
  U: ['█   █', '█   █', '█   █', '█   █', ' ███ '],
  M: ['█   █', '██ ██', '█ █ █', '█   █', '█   █'],
  C: [' ████', '█    ', '█    ', '█    ', ' ████'],
  P: ['████ ', '█   █', '████ ', '█    ', '█    '],
  ' ': ['   ', '   ', '   ', '   ', '   '],
};

/** Compact 3-row wordmark for screens narrower than ~70 columns. */
const SMALL_GLYPHS: Record<string, string[]> = {
  F: ['█▀▀', '█▀▀', '▀  '],
  R: ['█▀▄', '█▀▄', '▀ ▀'],
  E: ['█▀▀', '█▀▀', '▀▀▀'],
  B: ['█▀▄', '█▀▄', '▀▀ '],
  U: ['█ █', '█ █', '▀▀▀'],
  M: ['█▄█', '█ █', '▀ ▀'],
  C: ['█▀▀', '█  ', '▀▀▀'],
  P: ['█▀▄', '█▀▀', '▀  '],
  ' ': ['  ', '  ', '  '],
};

function render(text: string, glyphs: Record<string, string[]>): string[] {
  const rows = glyphs.F.length;
  const lines: string[] = new Array(rows).fill('');
  const characters = [...text.toUpperCase()];

  characters.forEach((character, index) => {
    const glyph = glyphs[character] ?? glyphs[' '];
    if (!glyph) return;
    for (let row = 0; row < rows; row += 1) {
      const separator = index === 0 ? '' : ' ';
      lines[row] += separator + (glyph[row] ?? '');
    }
  });

  return lines.map((line) => line.replace(/\s+$/, ''));
}

/** The 5-row "FREEBUFF MCP" wordmark. */
export function bannerLines(text: string = BANNER_TEXT): string[] {
  return render(text, BIG_GLYPHS);
}

/** The 3-row wordmark, used when the terminal is narrow. */
export function compactBannerLines(text: string = BANNER_TEXT): string[] {
  return render(text, SMALL_GLYPHS);
}

/** Width of the rendered wordmark (used to center/clip decorations). */
export function bannerWidth(compact = false): number {
  const lines = compact ? compactBannerLines() : bannerLines();
  return Math.max(...lines.map((line) => [...line].length));
}

/**
 * Pick the banner that fits `columns`.
 * Under 72 columns the 5-row art would wrap, which destroys the letterforms.
 */
export function bannerForWidth(columns: number): { lines: string[]; compact: boolean } {
  const compact = columns < 72;
  return { lines: compact ? compactBannerLines() : bannerLines(), compact };
}

/** Single-line mark used in the persistent header once the splash is gone. */
export const LOGO_MARK = '◆ FREEBUFF MCP';

/** Plain text version written to assets/banner.txt and `--banner`. */
export function bannerAsPlainText(): string {
  return [...bannerLines(), '', `  ${TAGLINE}`, `  ${SUBTITLE}`].join('\n');
}

/** Fake "system boot" lines shown under the splash banner. */
export const BOOT_LINES: string[] = [
  'mounting neon core',
  'linking mcp registry',
  'scanning termux capabilities',
  'loading skills',
  'calibrating agent loop',
];
