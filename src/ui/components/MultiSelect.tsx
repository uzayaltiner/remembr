/**
 * Custom multi-select for Ink. ink-select-input is single-select only,
 * so we roll a small one with arrow + space + enter.
 *
 * Items are pre-checked according to `defaultChecked` (default true).
 * Disabled items render greyed out and are skipped by space-toggle.
 */

import { Box, Text, useInput } from 'ink';
import type React from 'react';
import { type FC, useState } from 'react';

export interface MultiSelectItem<V extends string> {
  label: string;
  value: V;
  hint?: string;
  disabled?: boolean;
  defaultChecked?: boolean;
}

export interface MultiSelectProps<V extends string> {
  items: ReadonlyArray<MultiSelectItem<V>>;
  /** Called with the final set of checked values when the user hits Enter. */
  onSubmit: (selected: V[]) => void;
  /** Render a small footer hint (overrides default). */
  footer?: string;
}

export function MultiSelect<V extends string>({
  items,
  onSubmit,
  footer,
}: MultiSelectProps<V>): React.ReactElement {
  const initial = new Set<V>(
    items.filter((i) => !i.disabled && (i.defaultChecked ?? true)).map((i) => i.value),
  );
  const [checked, setChecked] = useState<Set<V>>(initial);
  const [cursor, setCursor] = useState(0);

  useInput((input, key) => {
    if (key.upArrow) {
      setCursor((c) => Math.max(0, c - 1));
      return;
    }
    if (key.downArrow) {
      setCursor((c) => Math.min(items.length - 1, c + 1));
      return;
    }
    if (input === ' ') {
      const item = items[cursor];
      if (!item || item.disabled) return;
      setChecked((prev) => {
        const next = new Set(prev);
        if (next.has(item.value)) next.delete(item.value);
        else next.add(item.value);
        return next;
      });
      return;
    }
    if (key.return) {
      onSubmit(items.filter((i) => checked.has(i.value)).map((i) => i.value));
    }
  });

  return (
    <Box flexDirection="column">
      {items.map((item, idx) => {
        const isCursor = idx === cursor;
        const isChecked = checked.has(item.value);
        const box = item.disabled ? '·' : isChecked ? '✓' : ' ';
        const labelColor = item.disabled ? 'gray' : isChecked ? 'green' : undefined;
        return (
          <Box key={item.value}>
            <Text color={isCursor ? 'cyan' : undefined} bold={isCursor}>
              {isCursor ? '› ' : '  '}
            </Text>
            <Text color={labelColor}>[{box}] </Text>
            <Text color={item.disabled ? 'gray' : undefined}>{item.label}</Text>
            {item.hint && (
              <Text dimColor>
                {'  '}
                {item.hint}
              </Text>
            )}
          </Box>
        );
      })}
      <Box marginTop={1}>
        <Text dimColor>{footer ?? '↑↓ move · space toggle · enter confirm'}</Text>
      </Box>
    </Box>
  );
}
