import React from 'react';
import { Box, Text } from 'ink';
import { palette, symbols } from '../utils/theme';
import { truncate } from '../utils/text';
import { formatDuration } from '../utils/text';

export type MessageRole = 'user' | 'assistant' | 'system' | 'error' | 'tool';

export interface ChatMessageView {
  id: string;
  role: MessageRole;
  content: string;
  meta?: Record<string, unknown>;
}

export interface ToolView {
  id: string;
  name: string;
  args: Record<string, unknown>;
  status: 'running' | 'ok' | 'failed' | 'denied';
  output?: string;
  durationMs?: number;
}

const INLINE_PATTERN = /(\*\*[^*]+\*\*|`[^`]+`|https?:\/\/\S+)/g;

/** Minimal inline markdown: bold, inline code, bare URLs. */
function renderInline(line: string, keyPrefix: string): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  INLINE_PATTERN.lastIndex = 0;

  while ((match = INLINE_PATTERN.exec(line)) !== null) {
    if (match.index > lastIndex) nodes.push(line.slice(lastIndex, match.index));
    const token = match[0];
    if (token.startsWith('**')) {
      nodes.push(
        <Text key={`${keyPrefix}-b-${match.index}`} bold color={palette.text}>
          {token.slice(2, -2)}
        </Text>,
      );
    } else if (token.startsWith('`')) {
      nodes.push(
        <Text key={`${keyPrefix}-c-${match.index}`} color={palette.cyan}>
          {token.slice(1, -1)}
        </Text>,
      );
    } else {
      nodes.push(
        <Text key={`${keyPrefix}-u-${match.index}`} color={palette.violet} underline>
          {token}
        </Text>,
      );
    }
    lastIndex = match.index + token.length;
  }
  if (lastIndex < line.length) nodes.push(line.slice(lastIndex));
  return nodes;
}

const CodeBlock: React.FC<{ code: string; language: string }> = ({ code, language }) => (
  <Box flexDirection="column" marginY={0} paddingLeft={1} borderStyle="single" borderTop={false} borderBottom={false} borderRight={false} borderColor={palette.violet}>
    {language ? <Text color={palette.dim}>{language}</Text> : null}
    <Text color={palette.text}>{code.replace(/\n+$/, '')}</Text>
  </Box>
);

const MarkdownBlock: React.FC<{ content: string }> = ({ content }) => {
  const segments = content.split(/(```[\w+#.-]*\n[\s\S]*?```)/g);
  return (
    <Box flexDirection="column">
      {segments.map((segment, index) => {
        if (segment.startsWith('```')) {
          const body = segment.replace(/^```/, '').replace(/```$/, '');
          const [firstLine, ...rest] = body.split('\n');
          const language = (firstLine ?? '').trim();
          const code = rest.join('\n');
          return <CodeBlock key={`code-${index}`} code={code} language={language} />;
        }
        const lines = segment.split('\n').filter((line, lineIndex, all) => !(line === '' && lineIndex === all.length - 1));
        return (
          <Box key={`text-${index}`} flexDirection="column">
            {lines.map((line, lineIndex) => (
              <Text key={`line-${index}-${lineIndex}`} wrap="wrap">
                {line.trim() === '' ? ' ' : renderInline(line, `${index}-${lineIndex}`)}
              </Text>
            ))}
          </Box>
        );
      })}
    </Box>
  );
};

const PREFIX: Record<MessageRole, { glyph: string; color: string; label: string }> = {
  user: { glyph: symbols.prompt, color: palette.magenta, label: 'you' },
  assistant: { glyph: symbols.diamond, color: palette.cyan, label: 'buffy' },
  system: { glyph: symbols.warn, color: palette.warning, label: 'system' },
  error: { glyph: symbols.cross, color: palette.danger, label: 'error' },
  tool: { glyph: symbols.spark, color: palette.violet, label: 'tool' },
};

export const MessageView: React.FC<{ message: ChatMessageView }> = ({ message }) => {
  const prefix = PREFIX[message.role] ?? PREFIX.system;
  const content = truncate(message.content, 6000);
  return (
    <Box flexDirection="column" marginBottom={0}>
      <Box>
        <Text color={prefix.color} bold>
          {prefix.glyph}{' '}
        </Text>
        <Text color={prefix.color} dimColor>
          {prefix.label}
        </Text>
      </Box>
      <Box paddingLeft={2} flexDirection="column">
        {message.role === 'assistant' ? (
          <MarkdownBlock content={content} />
        ) : (
          <Text color={message.role === 'error' ? palette.danger : palette.text} wrap="wrap">
            {content}
          </Text>
        )}
      </Box>
    </Box>
  );
};

/** Compact one-liner for a tool invocation. */
export const ToolLine: React.FC<{ tool: ToolView }> = ({ tool }) => {
  const statusColor =
    tool.status === 'ok' ? palette.success : tool.status === 'failed' ? palette.danger : tool.status === 'denied' ? palette.warning : palette.violet;
  const glyph = tool.status === 'ok' ? symbols.check : tool.status === 'failed' ? symbols.cross : tool.status === 'denied' ? symbols.warn : symbols.bullet;
  const target =
    (tool.args.path ?? tool.args.file ?? tool.args.url ?? tool.args.repo ?? tool.args.name ?? tool.args.command ?? '') as string;
  return (
    <Box>
      <Text color={statusColor}>{glyph} </Text>
      <Text color={palette.text}>{tool.name}</Text>
      {target ? <Text color={palette.muted}> {truncate(String(target), 60)}</Text> : null}
      {tool.durationMs !== undefined ? <Text color={palette.dim}> · {formatDuration(tool.durationMs)}</Text> : null}
      {tool.status === 'running' ? <Text color={palette.violet}> · running…</Text> : null}
    </Box>
  );
};

/** Collapsed tool output, shown only when the user opened the log tab. */
export const ToolOutput: React.FC<{ tool: ToolView }> = ({ tool }) => {
  if (!tool.output) return null;
  const lines = tool.output.split('\n').slice(0, 12);
  return (
    <Box flexDirection="column" paddingLeft={3}>
      {lines.map((line, index) => (
        <Text key={index} color={tool.status === 'failed' ? palette.danger : palette.muted} wrap="truncate-end">
          {truncate(line, 200)}
        </Text>
      ))}
    </Box>
  );
};
