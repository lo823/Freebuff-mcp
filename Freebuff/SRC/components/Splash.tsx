import React, { useEffect, useState } from 'react';
import { Box, Text } from 'ink';
import Gradient from 'ink-gradient';
import Spinner from 'ink-spinner';
import { BOOT_LINES, SUBTITLE, TAGLINE, bannerForWidth } from '../banner';
import { palette, symbols } from '../utils/theme';
import { GradientArt, GradientText } from './Gradient';
import { SafeRender } from './SafeRender';

/**
 * Launch screen: large block wordmark, neon sweep, fake-but-honest boot log
 * (each line reflects a real subsystem that was initialised).
 */
export const Splash: React.FC<{
  width: number;
  rows: number;
  version: string;
  model: string;
  mcpReady: number;
  mcpTotal: number;
  skillCount: number;
  workspace: string;
}> = ({ width, rows, version, model, mcpReady, mcpTotal, skillCount, workspace }) => {
  const { lines, compact } = bannerForWidth(width);
  const [step, setStep] = useState(0);
  const tight = rows < 20;

  useEffect(() => {
    const timer = setInterval(() => {
      setStep((current) => (current >= BOOT_LINES.length ? current : current + 1));
    }, 130);
    return () => clearInterval(timer);
  }, []);

  return (
    <Box flexDirection="column" width={width} alignItems="center" paddingTop={compact ? 0 : 1}>
      <GradientArt lines={lines} bold />

      <Box marginTop={1}>
        <SafeRender fallback={TAGLINE}>
          <Gradient colors={[palette.violet, palette.magenta, palette.cyan]}>{TAGLINE}</Gradient>
        </SafeRender>
      </Box>

      <Box marginTop={0}>
        <Text color={palette.muted}>{SUBTITLE}</Text>
      </Box>

      <Box marginTop={1} alignItems="center">
        <Text color={palette.violet}>{symbols.diamond} </Text>
        <Text color={palette.text}>{model}</Text>
        <Text color={palette.dim}> │ </Text>
        <Text color={palette.cyan}>
          {mcpReady}/{mcpTotal} mcp
        </Text>
        <Text color={palette.dim}> │ </Text>
        <Text color={palette.cyan}>{skillCount} skills</Text>
        <Text color={palette.dim}> │ </Text>
        <Text color={palette.muted}>v{version}</Text>
      </Box>

      {!tight && (
        <Box flexDirection="column" marginTop={1} width={Math.min(width - 4, 64)}>
          <GradientText text={`${symbols.block.repeat(Math.min(width - 4, 64))}`} dim />
          {BOOT_LINES.map((line, index) => {
            const done = index < step;
            const active = index === step;
            return (
              <Box key={line} marginLeft={1}>
                {done ? (
                  <Text color={palette.success}>{symbols.check} </Text>
                ) : active ? (
                  <Text color={palette.violet}>
                    <Spinner type="dots" />{' '}
                  </Text>
                ) : (
                  <Text color={palette.dim}>· </Text>
                )}
                <Text color={done ? palette.text : active ? palette.muted : palette.dim}>{line}</Text>
              </Box>
            );
          })}
        </Box>
      )}

      <Box marginTop={1}>
        <Text color={palette.dim}>workspace </Text>
        <Text color={palette.muted}>{workspace}</Text>
      </Box>
      <Box marginTop={1}>
        <Text color={palette.dim}>press any key to enter</Text>
      </Box>
    </Box>
  );
};
