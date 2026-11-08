import React from 'react';
import { Box, Text } from 'ink';
import { gradientBlock, gradientChars, palette, symbols, type GradientChar } from '../utils/theme';

/**
 * Gradient primitives.
 *
 * Terminal cells accept one color each, so a "gradient border" is built by
 * painting every border glyph individually and drawing the top/bottom rules
 * ourselves. The left/right strokes use the gradient midpoint, which is what
 * makes the panel read as a continuous neon frame.
 */

export const GradientText: React.FC<{
  text: string;
  from?: string;
  to?: string;
  bold?: boolean;
  dim?: boolean;
}> = ({ text, from = palette.violet, to = palette.cyan, bold, dim }) => {
  const chars = gradientChars(text, [from, to]);
  return (
    <Text bold={bold} dimColor={dim}>
      {chars.map((entry, index) => (
        <Text key={`${index}-${entry.char}`} color={entry.color}>
          {entry.char}
        </Text>
      ))}
    </Text>
  );
};

const CharRow: React.FC<{ chars: GradientChar[]; bold?: boolean }> = ({ chars, bold }) => (
  <Text bold={bold}>
    {chars.map((entry, index) => (
      <Text key={index} color={entry.color}>
        {entry.char}
      </Text>
    ))}
  </Text>
);

/** Multi-line block with one continuous diagonal sweep. */
export const GradientArt: React.FC<{ lines: string[]; from?: string; to?: string; bold?: boolean }> = ({
  lines,
  from = palette.violet,
  to = palette.cyan,
  bold = true,
}) => {
  const rows = gradientBlock(lines, [from, to]);
  return (
    <Box flexDirection="column">
      {rows.map((chars, index) => (
        <CharRow key={index} chars={chars} bold={bold} />
      ))}
    </Box>
  );
};

function topRule(width: number, title?: string): string {
  const safeWidth = Math.max(14, width);
  if (!title) return `${symbols.cornerTL}${symbols.hLine.repeat(safeWidth - 2)}${symbols.cornerTR}`;
  const label = ` ${title} `;
  const fill = Math.max(0, safeWidth - 2 - label.length - 1);
  return `${symbols.cornerTL}${symbols.hLine}${label}${symbols.hLine.repeat(fill)}${symbols.cornerTR}`;
}

function bottomRule(width: number, hint?: string): string {
  const safeWidth = Math.max(14, width);
  if (!hint) return `${symbols.cornerBL}${symbols.hLine.repeat(safeWidth - 2)}${symbols.cornerBR}`;
  const label = ` ${hint} `;
  const fill = Math.max(0, safeWidth - 2 - label.length - 1);
  return `${symbols.cornerBL}${symbols.hLine}${label}${symbols.hLine.repeat(fill)}${symbols.cornerBR}`;
}

export const NeonRule: React.FC<{ width: number; title?: string; from?: string; to?: string }> = ({
  width,
  title,
  from = palette.violet,
  to = palette.cyan,
}) => <GradientText text={topRule(width, title)} from={from} to={to} />;

/**
 * Panel with a real gradient frame.
 * Content is wrapped in a side-bordered Box so Ink still handles wrapping.
 */
export const GradientPanel: React.FC<{
  width: number;
  title?: string;
  footer?: string;
  children?: React.ReactNode;
  borderColor?: string;
  paddingX?: number;
}> = ({ width, title, footer, children, borderColor, paddingX = 1 }) => {
  const safeWidth = Math.max(20, width);
  return (
    <Box flexDirection="column" width={safeWidth}>
      <NeonRule width={safeWidth} title={title} />
      <Box
        borderStyle="single"
        borderTop={false}
        borderBottom={false}
        borderLeft
        borderRight
        borderColor={borderColor ?? palette.border}
        paddingX={paddingX}
        flexDirection="column"
      >
        {children}
      </Box>
      <GradientText text={bottomRule(safeWidth, footer)} />
    </Box>
  );
};

/** Horizontal separator sized to the terminal. */
export const Divider: React.FC<{ width: number; label?: string }> = ({ width, label }) => {
  if (!label) return <GradientText text={symbols.hLine.repeat(Math.max(4, width))} dim />;
  const safe = Math.max(8, width);
  const fill = Math.max(0, safe - label.length - 2);
  return <GradientText text={`${symbols.hLine} ${label} ${symbols.hLine.repeat(fill)}`} dim />;
};
