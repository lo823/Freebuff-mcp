import React from 'react';
import { Box, Text } from 'ink';
import Spinner from 'ink-spinner';
import { palette, symbols } from '../utils/theme';
import { prettyPath } from '../utils/paths';
import { formatTime, truncate } from '../utils/text';

export const StatusBar: React.FC<{
  width: number;
  provider: string;
  model: string;
  tokens: number;
  mcpReady: number;
  mcpTotal: number;
  skillsActive: number;
  busy: boolean;
  workspace: string;
  status: string;
}> = ({ width, provider, model, tokens, mcpReady, mcpTotal, skillsActive, busy, workspace, status }) => {
  const compact = width < 68;
  const tokenLabel = tokens > 999 ? `${(tokens / 1000).toFixed(1)}k` : String(tokens);
  const separator = <Text color={palette.dim}> │ </Text>;

  return (
    <Box flexDirection="column" width={width}>
      <Box width={width}>
        {busy ? (
          <Text color={palette.cyan}>
            <Spinner type="dots" />
          </Text>
        ) : (
          <Text color={palette.success}>{symbols.bullet}</Text>
        )}
        <Text color={palette.muted}> </Text>
        <Text color={palette.cyan}>{truncate(model, compact ? 18 : 28)}</Text>
        {!compact ? (
          <>
            {separator}
            <Text color={palette.dim}>{truncate(provider, 14)}</Text>
          </>
        ) : null}
        {separator}
        <Text color={palette.violet}>{tokenLabel} tok</Text>
        {separator}
        <Text color={palette.muted}>
          mcp <Text color={mcpReady === mcpTotal ? palette.success : palette.warning}>{mcpReady}</Text>/{mcpTotal}
        </Text>
        {!compact ? (
          <>
            {separator}
            <Text color={palette.muted}>skills {skillsActive}</Text>
          </>
        ) : null}
        <Box flexGrow={1} />
        <Text color={palette.dim}>{truncate(status, compact ? 10 : 18)}</Text>
        {separator}
        <Text color={palette.dim}>{formatTime()}</Text>
      </Box>
      <Box width={width}>
        <Text color={palette.dim}>workspace </Text>
        <Text color={palette.muted}>{truncate(prettyPath(workspace), Math.max(10, width - 20))}</Text>
      </Box>
    </Box>
  );
};
