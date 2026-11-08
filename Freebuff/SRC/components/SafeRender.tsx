import React from 'react';
import { Text } from 'ink';

/**
 * Error boundary for purely decorative subtrees.
 *
 * Some third-party Ink add-ons (ink-gradient is the usual suspect) assume an
 * older Ink API. If one of them throws, the rest of the interface must keep
 * working — a broken gradient should never take down the agent.
 */

interface Props {
  children?: React.ReactNode;
  fallback?: string;
}

interface State {
  failed: boolean;
}

export class SafeRender extends React.Component<Props, State> {
  state: State = { failed: false };

  static getDerivedStateFromError(): State {
    return { failed: true };
  }

  componentDidCatch(): void {
    // Intentionally silent: the fallback is rendered instead.
  }

  render(): React.ReactNode {
    if (this.state.failed) return <Text dimColor>{this.props.fallback ?? ''}</Text>;
    return this.props.children;
  }
}
