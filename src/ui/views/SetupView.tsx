/**
 * Ink-based setup TUI.
 *
 * Single-screen state machine. Each phase renders into the same Box,
 * advancing on user confirmation. The final sync phase streams real
 * `IndexEvent`s out of `runSync` and turns them into per-plugin
 * progress bars in real time.
 *
 * The state machine itself (which phases to skip, FDA edge cases, …)
 * is the same shape as `runSetup` — see src/commands/setup.ts. This
 * file is only the view layer.
 */

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { Box, Text, useApp, useInput } from 'ink';
import TextInput from 'ink-text-input';
import { type FC, useEffect, useState } from 'react';
import type { IndexEvent, IndexEventListener } from '../../commands/index-cmd.js';
import { runInit } from '../../commands/init.js';
import {
  type McpClient,
  detectInstalledClients,
  installMcpFor,
} from '../../commands/mcp-install.js';
import { runSync } from '../../commands/sync-cmd.js';
import {
  type BrainConfig,
  configExists,
  ensureHome,
  readConfig,
  writeConfig,
} from '../../config/settings.js';
import { markPhase, readSetupState, resetSetupState } from '../../config/setup-state.js';
import { type FdaStatus, checkFullDiskAccess, openFdaSystemSettings } from '../../utils/fda.js';
import { MultiSelect } from '../components/MultiSelect.js';
import { ProgressBar } from '../components/ProgressBar.js';

type Phase = 'paths' | 'apple' | 'fda-blocked' | 'mcp' | 'sync' | 'done';

export interface SetupViewProps {
  /** When true, wipe state file before starting. */
  reset?: boolean;
}

export const SetupView: FC<SetupViewProps> = ({ reset = false }) => {
  const { exit } = useApp();

  // ── persistent state from disk
  const [phase, setPhase] = useState<Phase>('paths');
  const [config, setConfig] = useState<BrainConfig | null>(null);

  // ── transient prompt UI state
  const [pathInput, setPathInput] = useState<string>('');

  // ── sync state
  const [syncStarted, setSyncStarted] = useState(false);
  const [syncProgress, setSyncProgress] = useState<Map<string, PluginSyncState>>(new Map());

  // bootstrap once on mount
  useEffect(() => {
    if (reset) resetSetupState();
    if (!configExists()) {
      ensureHome();
      runInit({ quiet: true });
    }
    markPhase('bootstrap', true);
    const cfg = readConfig();
    setConfig(cfg);

    const state = readSetupState();
    if (state.phases.paths.completed) {
      decidePathsCompleted();
    }
  }, [reset]);

  // Auto-advance after paths. The 'apple' UI phase is the question that
  // resolves the persistent 'fda' state — we use the 'apple' UI step
  // whenever fda hasn't been answered yet.
  function decidePathsCompleted(): void {
    const next = readSetupState();
    if (!next.phases.fda.completed) {
      setPhase('apple');
      return;
    }
    if (!next.phases.mcp.completed) {
      setPhase('mcp');
      return;
    }
    setPhase('sync');
  }

  // ───────────────────────── handlers
  const submitPaths = (): void => {
    if (!config) return;
    const paths = [pathInput.trim() || join(homedir(), 'Documents')].filter(Boolean);
    acceptPaths(config, paths, setConfig);
    setPhase('apple');
  };

  const submitApple = (selected: string[]): void => {
    if (!config) return;
    let cfg = config;
    const wantNotes = selected.includes('apple-notes');
    const wantCal = selected.includes('calendar');
    const wantMail = selected.includes('mail');

    cfg = setEnabled(cfg, 'apple-notes', wantNotes);
    cfg = setEnabled(cfg, 'calendar', wantCal);
    cfg = setEnabled(cfg, 'mail', wantMail);

    if (!wantNotes && !wantCal && !wantMail) {
      writeConfig(cfg);
      setConfig(cfg);
      markPhase('fda', true, 'declined');
      setPhase('mcp');
      return;
    }

    const fda: FdaStatus = checkFullDiskAccess();
    if (fda === 'unavailable') {
      cfg = setEnabled(cfg, 'apple-notes', false);
      cfg = setEnabled(cfg, 'calendar', false);
      cfg = setEnabled(cfg, 'mail', false);
      writeConfig(cfg);
      setConfig(cfg);
      markPhase('fda', true, 'unavailable');
      setPhase('mcp');
      return;
    }
    if (fda === 'denied') {
      writeConfig(cfg);
      setConfig(cfg);
      markPhase('fda', false, 'denied');
      setPhase('fda-blocked');
      return;
    }

    writeConfig(cfg);
    setConfig(cfg);
    markPhase('fda', true, 'granted');
    setPhase('mcp');
  };

  const submitMcp = (selected: string[]): void => {
    const detected = detectInstalledClients();
    for (const client of detected) {
      if (selected.includes(client.name)) installMcpFor(client);
    }
    markPhase('mcp', true, `installed:${selected.length}`);
    setPhase('sync');
  };

  // Sync runner — kicks off when we land on 'sync'
  useEffect(() => {
    if (phase !== 'sync' || syncStarted) return;
    setSyncStarted(true);

    const onEvent: IndexEventListener = (ev: IndexEvent) => {
      setSyncProgress((prev) => {
        const next = new Map(prev);
        const existing = next.get(ev.plugin) ?? newPluginState();
        if (ev.kind === 'start') {
          next.set(ev.plugin, { ...existing, state: 'running' });
        } else if (ev.kind === 'progress') {
          next.set(ev.plugin, {
            ...existing,
            state: 'running',
            current: ev.current,
            total: ev.total,
            message: ev.message,
          });
        } else if (ev.kind === 'done') {
          next.set(ev.plugin, {
            ...existing,
            state: 'done',
            chunks: ev.chunks,
            elapsedMs: ev.elapsedMs,
            current: existing.total,
          });
        } else if (ev.kind === 'error') {
          next.set(ev.plugin, { ...existing, state: 'error', message: ev.error });
        }
        return next;
      });
    };

    runSync({ onEvent })
      .then(() => {
        markPhase('sync', true, 'ok');
        setPhase('done');
      })
      .catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        markPhase('sync', false, message);
        setPhase('done');
      });
  }, [phase, syncStarted]);

  // ───────────────────────── input wiring
  useInput((input, key) => {
    if (phase === 'paths') {
      if (key.return) {
        submitPaths();
        return;
      }
      // '+' to add another path goes through TextInput onSubmit below.
    }
    if (phase === 'fda-blocked' && key.return) {
      void openFdaSystemSettings().catch(() => undefined);
      exit();
    }
    if (phase === 'done' && (key.return || input === 'q' || key.escape)) {
      exit();
    }
  });

  // ───────────────────────── rendering
  return (
    <Box flexDirection="column" paddingX={1} paddingY={1}>
      <Box marginBottom={1}>
        <Text color="magenta" bold>
          remembr setup
        </Text>
        <Text dimColor> · local-first semantic search</Text>
      </Box>

      {phase === 'paths' && (
        <Box flexDirection="column">
          <Text>Which directory should remembr index for notes / PDFs?</Text>
          <Box marginTop={1}>
            <Text color="cyan">› </Text>
            <TextInput
              value={pathInput}
              onChange={setPathInput}
              placeholder={join(homedir(), 'Documents')}
              onSubmit={submitPaths}
            />
          </Box>
          <Box marginTop={1}>
            <Text dimColor>Press Enter to confirm. Empty = ~/Documents.</Text>
          </Box>
        </Box>
      )}

      {phase === 'apple' && (
        <Box flexDirection="column">
          <Text>Which Apple sources should remembr index?</Text>
          <Text dimColor>Notes / Calendar / Mail need Full Disk Access.</Text>
          <Box marginTop={1}>
            <MultiSelect
              items={[
                { label: 'Apple Notes', value: 'apple-notes', defaultChecked: true },
                { label: 'Calendar', value: 'calendar', defaultChecked: true },
                { label: 'Mail', value: 'mail', defaultChecked: true },
              ]}
              onSubmit={submitApple}
            />
          </Box>
        </Box>
      )}

      {phase === 'fda-blocked' && (
        <Box flexDirection="column">
          <Text color="red">✗ Full Disk Access is not granted to this terminal.</Text>
          <Box marginTop={1} flexDirection="column">
            <Text>Steps:</Text>
            <Text>1. System Settings → Privacy &amp; Security → Full Disk Access</Text>
            <Text>2. Add your terminal app (Terminal / iTerm / Warp / Ghostty)</Text>
            <Text>3. Quit the terminal completely (Cmd+Q) and re-open it</Text>
            <Text>4. In the new terminal, run: remembr setup</Text>
          </Box>
          <Box marginTop={1}>
            <Text color="cyan">Press Enter to open System Settings now.</Text>
          </Box>
        </Box>
      )}

      {phase === 'mcp' && (
        <Box flexDirection="column">
          <Text>Which MCP clients should be wired up to remembr?</Text>
          <Box marginTop={1}>
            <McpStep onSubmit={submitMcp} />
          </Box>
        </Box>
      )}

      {phase === 'sync' && (
        <Box flexDirection="column">
          <Text bold>Indexing your data…</Text>
          <Box flexDirection="column" marginTop={1}>
            {[...syncProgress.entries()].map(([plugin, st]) => (
              <Box key={plugin}>
                <Box width={14}>
                  <Text color={pluginColor(st.state)}>{plugin}</Text>
                </Box>
                <ProgressBar current={st.current} total={st.total} trailing={pluginTrailing(st)} />
              </Box>
            ))}
            {syncProgress.size === 0 && <Text dimColor>warming up the embedder…</Text>}
          </Box>
        </Box>
      )}

      {phase === 'done' && (
        <Box flexDirection="column">
          <Text color="green">✓ Setup complete.</Text>
          <Box marginTop={1} flexDirection="column">
            <Text>Try it:</Text>
            <Text>
              <Text color="cyan">remembr "your query"</Text>
            </Text>
            <Text>
              <Text color="cyan">remembr</Text>
              <Text dimColor> (interactive TUI)</Text>
            </Text>
            <Text>
              <Text color="cyan">remembr status</Text>
              <Text dimColor> (health + indexed counts)</Text>
            </Text>
          </Box>
          <Box marginTop={1}>
            <Text dimColor>Restart your MCP client to see remembr in the tools list.</Text>
          </Box>
          <Box marginTop={1}>
            <Text dimColor>Press Enter or Esc to exit.</Text>
          </Box>
        </Box>
      )}
    </Box>
  );
};

// ──────────────────────────────────────────────────────────
// MCP step is its own component because detection runs synchronously
// at mount and gets used by the multi-select list.

const McpStep: FC<{ onSubmit: (selected: string[]) => void }> = ({ onSubmit }) => {
  const detected = detectInstalledClients();

  if (detected.length === 0) {
    // Auto-skip if nothing's detected.
    useEffect(() => {
      onSubmit([]);
    }, [onSubmit]);
    return <Text dimColor>No MCP-aware clients detected. Skipping…</Text>;
  }

  const items = detected.map((c: McpClient) => ({
    label: c.label,
    value: c.name,
    defaultChecked: true,
  }));

  return <MultiSelect items={items} onSubmit={onSubmit} />;
};

// ──────────────────────────────────────────────────────────
// Helpers

interface PluginSyncState {
  state: 'pending' | 'running' | 'done' | 'error';
  current: number;
  total: number;
  message?: string;
  chunks?: number;
  elapsedMs?: number;
}

function newPluginState(): PluginSyncState {
  return { state: 'running', current: 0, total: 0 };
}

function pluginColor(state: PluginSyncState['state']): string | undefined {
  if (state === 'done') return 'green';
  if (state === 'error') return 'red';
  if (state === 'running') return 'cyan';
  return undefined;
}

function pluginTrailing(st: PluginSyncState): string | undefined {
  if (st.state === 'done') {
    const sec = st.elapsedMs ? `${(st.elapsedMs / 1000).toFixed(1)}s` : '';
    return `✓ ${st.chunks ?? 0} chunks · ${sec}`;
  }
  if (st.state === 'error') return `✗ ${st.message ?? 'error'}`;
  return st.message;
}

function acceptPaths(
  config: BrainConfig,
  paths: string[],
  setConfig: (next: BrainConfig) => void,
): void {
  let cfg = config;
  for (const raw of paths) {
    const expanded = expandPath(raw);
    if (!existsSync(expanded)) continue;
    cfg = addPath(cfg, 'fs', expanded);
    cfg = addPath(cfg, 'pdf', expanded);
  }
  writeConfig(cfg);
  setConfig(cfg);
  markPhase('paths', true, 'configured');
}

function addPath(config: BrainConfig, plugin: string, path: string): BrainConfig {
  const slot = config.plugins[plugin] ?? { enabled: true };
  const existing = (slot.paths as string[] | undefined) ?? [];
  const next = existing.includes(path) ? existing : [...existing, path];
  return {
    ...config,
    plugins: {
      ...config.plugins,
      [plugin]: { ...slot, enabled: true, paths: next },
    },
  };
}

function setEnabled(config: BrainConfig, plugin: string, enabled: boolean): BrainConfig {
  const slot = config.plugins[plugin] ?? { enabled };
  return {
    ...config,
    plugins: {
      ...config.plugins,
      [plugin]: { ...slot, enabled },
    },
  };
}

function expandPath(p: string): string {
  let out = p;
  if (out.startsWith('~')) out = join(homedir(), out.slice(1));
  return isAbsolute(out) ? out : resolve(out);
}
