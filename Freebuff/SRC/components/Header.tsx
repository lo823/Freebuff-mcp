import React from 'react';
import { Box, Text } from 'ink';
import { LOGO_MARK } from '../banner';
import { palette } from '../utils/theme';
import { Divider, GradientText } from './Gradient';

export type Tab = 'chat' | 'mcp' | 'skills' | 'log';

const TABS: Array<{ id: Tab; label: string; key: string }> = [
  { id: 'chat', label: 'chat', key: '1' },
  { id: 'mcp', label: 'mcp', key: '2' },
  { id: 'skills', label: 'skills', key: '3' },
  { id: 'log', label: 'log', key: '4' },
];

export const Header: React.FC<{
  width: number;
  tab: Tab;
  version: string;
  provider: string;
}> = ({ width, tab, version, provider }) => (
  <Box flexDirection="column" width={width}>
    <Box width={width}>
      <GradientText text={LOGO_MARK} bold />
      <Text dimColor> v{version}</Text>
      <Box flexGrow={1} />
      {TABS.map((entry) => (
        <Box key={entry.id} marginLeft={1}>
          <Text color={entry.id === tab ? palette.cyan : palette.dim} bold={entry.id === tab} inverse={entry.id === tab}>
            {` ${entry.label} `}
          </Text>
        </Box>
      ))}
    </Box>
    <Box width={width}>
      <Divider width={width} label={`${provider} · Ctrl+T tab · Ctrl+C quit`} />
    </Box>
  </Box>
);
