import React from 'react';
import { Box, Text } from 'ink';
import Spinner from 'ink-spinner';
import { palette, symbols } from '../utils/theme';
import { GradientPanel, GradientText } from './Gradient';
import { MessageView, ToolLine, type ChatMessageView, type ToolView } from './MessageView';

/**
 * Transcript view.
 *
 * Keeps the last messages that fit the terminal budget so the layout never
 * scrolls Ink's frame on a small phone screen. Full history stays available
 * through the chat MCP.
 */

const SUGGESTIONS = [
  { th: 'สแกน ./app.apk', en: 'reverse-engineer an APK' },
  { th: 'สร้างโปรเจกต์ godot neon', en: 'scaffold a Godot game' },
  { th: 'ติดตั้งสกิล superpowers', en: 'install a skill by name' },
  { th: 'สถานะ', en: 'environment + MCP report' },
];

function estimateRows(content: string, width: number): number {
  const perLine = Math.max(24, width - 6);
  const lines = content.split('\n');
  const wrapped = lines.reduce((total, line) => total + Math.max(1, Math.ceil(line.length / perLine)), 0);
  return Math.min(18, wrapped + 2);
}

export const ChatPanel: React.FC<{
  width: number;
  height: number;
  messages: ChatMessageView[];
  streaming: string;
  busy: boolean;
  tools: ToolView[];
  model: string;
  provider: string;
}> = ({ width, height, messages, streaming, busy, tools, model, provider }) => {
  const panelWidth = Math.max(30, width);
  const budget = Math.max(8, height - 14);

  const visible: ChatMessageView[] = [];
  let used = 0;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index] as ChatMessageView;
    const rows = estimateRows(message.content, panelWidth);
    if (used + rows > budget && visible.length > 0) break;
    used += rows;
    visible.unshift(message);
  }

  const activeTools = tools.filter((tool) => tool.status === 'running');
  const recentTools = tools.slice(-3);
  const empty = visible.length === 0 && !streaming;

  return (
    <GradientPanel width={panelWidth} title={`NEON LINK · ${provider}/${model}`} footer={busy ? 'generating' : 'idle'}>
      {empty ? (
        <Box flexDirection="column">
          <GradientText text={'◆ AI-FREEBUFF online'} bold />
          <Text color={palette.muted}>
            Termux agent · 9 MCP servers · 4 skills. Type in Thai or English.
          </Text>
          <Box marginTop={1} flexDirection="column">
            {SUGGESTIONS.map((suggestion) => (
              <Box key={suggestion.th}>
                <Text color={palette.violet}>{symbols.arrow} </Text>
                <Text color={palette.text}>{suggestion.th}</Text>
                <Text color={palette.dim}> — {suggestion.en}</Text>
              </Box>
            ))}
          </Box>
          <Box marginTop={1}>
            <Text color={palette.dim}>Ctrl+T switch panels · Tab/Enter submit · Esc cancel</Text>
          </Box>
        </Box>
      ) : (
        <Box flexDirection="column">
          {visible.map((message) => (
            <MessageView key={message.id} message={message} />
          ))}

          {streaming ? (
            <Box flexDirection="column">
              <Box>
                <Text color={palette.cyan} bold>
                  {symbols.diamond}{' '}
                </Text>
                <Text color={palette.cyan} dimColor>
                  buffy
                </Text>
              </Box>
              <Box paddingLeft={2}>
                <Text color={palette.text} wrap="wrap">
                  {streaming}
                </Text>
                <Text color={palette.cyan}>{symbols.block}</Text>
              </Box>
            </Box>
          ) : null}

          {busy && !streaming ? (
            <Box marginTop={1}>
              <Text color={palette.violet}>
                <Spinner type="dots" />{' '}
              </Text>
              <Text color={palette.muted}>{activeTools.length ? `running ${activeTools.map((tool) => tool.name).join(', ')}` : 'thinking'}</Text>
            </Box>
          ) : null}

          {recentTools.length > 0 ? (
            <Box flexDirection="column" marginTop={1}>
              {recentTools.map((tool) => (
                <ToolLine key={tool.id} tool={tool} />
              ))}
            </Box>
          ) : null}
        </Box>
      )}
    </GradientPanel>
  );
};
