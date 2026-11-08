/**
 * Dark-cyberpunk visual language.
 *
 * Pure black background, neon purple -> cyan gradients, block glyphs only.
 * The gradient helpers return per-character colors so Ink can render a smooth
 * sweep even on terminals without truecolor (they degrade to the nearest
 * supported color automatically).
 */

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

export interface GradientChar {
  char: string;
  color: string;
}

export const palette = {
  violet: '#7C3AED',
  purple: '#9333EA',
  magenta: '#C026D3',
  cyan: '#06B6D4',
  teal: '#14B8A6',
  blue: '#3B82F6',
  ink: '#05050A',
  surface: '#0B0B16',
  surfaceAlt: '#12121F',
  border: '#2A2A45',
  text: '#E5E7EB',
  muted: '#8B8BA7',
  dim: '#4B4B63',
  success: '#22D3EE',
  warning: '#FBBF24',
  danger: '#FB7185',
} as const;

export const gradientStops = [palette.violet, palette.magenta, palette.cyan] as const;
const primaryStops = [palette.violet, palette.cyan];

export const symbols = {
  diamond: '◆',
  diamondOpen: '◇',
  bullet: '●',
  dot: '•',
  arrow: '❯',
  prompt: '❯',
  check: '✔',
  cross: '✖',
  warn: '▲',
  spark: '✦',
  wave: '〜',
  cactus: '🌵',
  block: '█',
  shadeLight: '░',
  shadeMedium: '▒',
  shadeDark: '▓',
  hLine: '─',
  vLine: '│',
  cornerTL: '╭',
  cornerTR: '╮',
  cornerBL: '╰',
  cornerBR: '╯',
} as const;

export function hexToRgb(hex: string): Rgb {
  const clean = hex.replace('#', '').trim();
  const full =
    clean.length === 3
      ? clean
          .split('')
          .map((c) => c + c)
          .join('')
      : clean.padEnd(6, '0').slice(0, 6);
  return {
    r: parseInt(full.slice(0, 2), 16) || 0,
    g: parseInt(full.slice(2, 4), 16) || 0,
    b: parseInt(full.slice(4, 6), 16) || 0,
  };
}

export function rgbToHex({ r, g, b }: Rgb): string {
  const part = (n: number): string =>
    Math.max(0, Math.min(255, Math.round(n)))
      .toString(16)
      .padStart(2, '0');
  return `#${part(r)}${part(g)}${part(b)}`;
}

/** Linear interpolation between two hex colors, `t` in [0, 1]. */
export function mix(from: string, to: string, t: number): string {
  const a = hexToRgb(from);
  const b = hexToRgb(to);
  const clamped = Math.max(0, Math.min(1, t));
  return rgbToHex({
    r: a.r + (b.r - a.r) * clamped,
    g: a.g + (b.g - a.g) * clamped,
    b: a.b + (b.b - a.b) * clamped,
  });
}

export function lighten(hex: string, amount = 0.2): string {
  return mix(hex, '#FFFFFF', amount);
}

export function darken(hex: string, amount = 0.2): string {
  return mix(hex, '#000000', amount);
}

/** Sample a multi-stop gradient at position `t` in [0, 1]. */
export function sampleStops(stops: readonly string[], t: number): string {
  if (stops.length === 0) return palette.text;
  if (stops.length === 1) return stops[0] as string;
  const clamped = Math.max(0, Math.min(1, t));
  const scaled = clamped * (stops.length - 1);
  const index = Math.min(stops.length - 2, Math.floor(scaled));
  return mix(stops[index] as string, stops[index + 1] as string, scaled - index);
}

/**
 * Paint a single line. Colors are interpolated per visible character so the
 * neon sweep is continuous rather than per-word.
 */
export function gradientChars(
  text: string,
  stops: readonly string[] = gradientStops,
  offset = 0,
  span = 1,
): GradientChar[] {
  const chars = [...text];
  const denom = Math.max(1, chars.length - 1);
  return chars.map((char, index) => ({
    char,
    color: sampleStops(stops, offset + (index / denom) * span),
  }));
}

/**
 * Paint a block of lines with one continuous gradient flowing diagonally
 * across the whole block, which is what makes the ASCII banner feel layered.
 */
export function gradientBlock(
  lines: readonly string[],
  stops: readonly string[] = gradientStops,
): GradientChar[][] {
  const maxWidth = Math.max(1, ...lines.map((line) => [...line].length));
  const height = Math.max(1, lines.length - 1);
  return lines.map((line, row) =>
    [...line].map((char, col) => ({
      char,
      color: sampleStops(
        stops,
        Math.max(0, Math.min(1, col / Math.max(1, maxWidth - 1) * 0.72 + (row / Math.max(1, height)) * 0.28)),
      ),
    })),
  );
}

/** A full-width gradient divider built from box-drawing characters. */
export function gradientRule(width: number, char = symbols.hLine): GradientChar[] {
  const safeWidth = Math.max(1, Math.min(width, 400));
  return gradientChars(char.repeat(safeWidth), primaryStops);
}

export function gradientLabel(text: string): GradientChar[] {
  return gradientChars(text, primaryStops);
}

/** Color for an MCP/skill status lamp. */
export function statusColor(status: 'ready' | 'degraded' | 'unavailable' | 'installing' | 'unknown'): string {
  switch (status) {
    case 'ready':
      return palette.success;
    case 'degraded':
      return palette.warning;
    case 'unavailable':
      return palette.danger;
    case 'installing':
      return palette.violet;
    default:
      return palette.muted;
  }
}
