import { useEffect, useState } from 'react';
import { useStdout } from 'ink';

export interface TerminalSize {
  columns: number;
  rows: number;
}

/**
 * Tracks terminal dimensions. Termux users rotate the device and resize the
 * keyboard often, so every layout decision reads from here.
 */
export function useTerminalSize(): TerminalSize {
  const { stdout } = useStdout();
  const [size, setSize] = useState<TerminalSize>({
    columns: stdout?.columns || 80,
    rows: stdout?.rows || 24,
  });

  useEffect(() => {
    if (!stdout) return undefined;
    const handleResize = (): void => {
      setSize({ columns: stdout.columns || 80, rows: stdout.rows || 24 });
    };
    handleResize();
    stdout.on('resize', handleResize);
    return () => {
      stdout.off('resize', handleResize);
    };
  }, [stdout]);

  return size;
}
