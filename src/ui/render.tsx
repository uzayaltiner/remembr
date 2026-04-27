/**
 * Bridge between commander's "no subcommand" path and the Ink TUI.
 *
 * Renders the App, waits for the user to choose or quit, then prints
 * the chosen target to stdout (after Ink has unmounted) so it pipes
 * cleanly to other tools or sits unobtrusively in the scrollback.
 */

import { render } from 'ink';
import React from 'react';
import { configExists, readConfig } from '../config/settings.ts';
import { EmbedderError, createEmbedder } from '../core/embedder/index.ts';
import type { SearchResult } from '../core/store.ts';
import { App } from './App.tsx';

export async function renderTUI(): Promise<void> {
  // Surface init / connectivity problems before clearing the screen with Ink.
  if (!configExists()) {
    console.error("✗ Not initialized. Run 'remembr init' first.");
    process.exit(1);
  }

  const config = readConfig();
  const embedder = createEmbedder(config);
  try {
    await embedder.init();
  } catch (err) {
    const message =
      err instanceof EmbedderError ? err.message : err instanceof Error ? err.message : String(err);
    console.error(`✗ ${message}`);
    console.error("  Run 'remembr status' to diagnose.");
    process.exit(1);
  }

  let chosen: SearchResult | null = null;

  const ink = render(
    <App
      onChoose={(result) => {
        chosen = result;
      }}
    />,
  );

  await ink.waitUntilExit();

  if (chosen) {
    const target = (chosen as SearchResult).url ?? (chosen as SearchResult).documentId;
    process.stdout.write(`${target}\n`);
  }
}
