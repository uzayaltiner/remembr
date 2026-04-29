/**
 * Tiny progress bar component for the setup sync screen.
 *
 * Renders something like:
 *   ████████░░░░░░░░░░░░  340/1247  (27%)
 *
 * Width is fixed to the same number of cells regardless of state so the
 * surrounding lines don't reflow on every update — Ink re-renders the
 * whole frame, and uneven widths look jittery.
 */

import { Box, Text } from 'ink';
import React, { type FC } from 'react';

export interface ProgressBarProps {
  current: number;
  total: number;
  width?: number;
  /** Optional extra label after the count, e.g. "ETA 8s". */
  trailing?: string;
}

export const ProgressBar: FC<ProgressBarProps> = ({ current, total, width = 24, trailing }) => {
  const safeTotal = total > 0 ? total : 0;
  const ratio = safeTotal === 0 ? 0 : Math.min(1, current / safeTotal);
  const filled = Math.round(ratio * width);
  const empty = width - filled;
  const pct = Math.round(ratio * 100);

  const counts = safeTotal > 0 ? `${current}/${safeTotal}` : `${current}`;

  return (
    <Box>
      <Text color="cyan">{'█'.repeat(filled)}</Text>
      <Text dimColor>{'░'.repeat(empty)}</Text>
      <Text>
        {'  '}
        {counts}
      </Text>
      {safeTotal > 0 && (
        <Text dimColor>
          {'  '}({pct}%)
        </Text>
      )}
      {trailing && (
        <Text dimColor>
          {'  '}
          {trailing}
        </Text>
      )}
    </Box>
  );
};
