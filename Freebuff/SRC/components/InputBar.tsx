import React from 'react';
import { Box, Text } from 'ink';
import TextInput from 'ink-text-input';
import Spinner from 'ink-spinner';
import { palette, symbols } from '../utils/theme';
import { GradientText } from './Gradient';

export const InputBar: React.FC<{
  width: number;
  value: string;
  onChange: (value: string) => void;
  onSubmit: (value: string) => void;
  disabled: boolean;
  busy: boolean;
  hint?: string;
}> = ({ width, value, onChange, onSubmit, disabled, busy, hint }) => (
  <Box flexDirection="column" width={Math.max(20, width)}>
    <GradientText text={symbols.hLine.repeat(Math.max(20, width))} dim />
    <Box>
      <Text color={busy ? palette.dim : palette.violet} bold>
        {symbols.prompt}{' '}
      </Text>
      {disabled ? (
        <Box>
          <Text color={palette.violet}>
            <Spinner type="dots" />{' '}
          </Text>
          <Text color={palette.muted}>{busy ? 'working… Esc to cancel' : 'unavailable'}</Text>
        </Box>
      ) : (
        <TextInput
          value={value}
          onChange={onChange}
          onSubmit={onSubmit}
          placeholder="ถามอะไรก็ได้ · ask anything"
          focus
        />
      )}
    </Box>
    <Box>
      <Text color={palette.dim}>{hint ?? 'Enter send · Ctrl+T panels · /help for commands'}</Text>
    </Box>
  </Box>
);
