/**
 * `remembr mcp install` — register the remembr MCP server with one or more
 * MCP-aware editors / clients.
 *
 * Each supported client stores its MCP server list in a JSON file at a
 * known path. We detect which clients are installed (the file exists),
 * write a backup, and merge an `mcpServers.remembr` entry in.
 *
 * Idempotent: re-running with the same (or equivalent) entry is a no-op.
 *
 * If the user has manually edited the config we leave existing keys
 * untouched; we only set the `remembr` key under `mcpServers`.
 */

import { execSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export type ClientName = 'claude-code' | 'cursor' | 'cline';

export interface McpClient {
  /** Stable client id (used in CLI flags + return value). */
  name: ClientName;
  /** Human-readable label (used in CLI output). */
  label: string;
  /** Absolute path to the JSON config file we mutate. */
  configPath: string;
  /** Where the `mcpServers` map lives in the JSON. */
  serversPath: string[];
  /**
   * Returns true when the client is genuinely installed on this machine.
   * Different clients leave different fingerprints (CLI binary, dotfile,
   * IDE extension dir) so each implements its own probe.
   */
  isInstalled: () => boolean;
}

export interface InstallResult {
  client: ClientName;
  configPath: string;
  status: 'installed' | 'updated' | 'unchanged' | 'created' | 'skipped';
  reason?: string;
}

const CLAUDE_CONFIG = join(homedir(), '.claude.json');
const CURSOR_CONFIG_DIR = join(homedir(), '.cursor');
const CURSOR_CONFIG = join(CURSOR_CONFIG_DIR, 'mcp.json');
const CLINE_GLOBAL_STORAGE = join(
  homedir(),
  'Library',
  'Application Support',
  'Code',
  'User',
  'globalStorage',
  'saoudrizwan.claude-dev',
);
const CLINE_CONFIG = join(CLINE_GLOBAL_STORAGE, 'settings', 'cline_mcp_settings.json');

/**
 * Resolve a binary on PATH without throwing on missing.
 * Returns true if `command -v <name>` exits 0.
 */
function commandExists(name: string): boolean {
  // Defensive: only allow safe binary-name chars to avoid shell injection
  // even though all current call sites pass hardcoded literals.
  if (!/^[A-Za-z0-9._-]+$/.test(name)) return false;
  try {
    execSync(`command -v ${name}`, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

export const SUPPORTED_CLIENTS: McpClient[] = [
  {
    name: 'claude-code',
    label: 'Claude Code',
    configPath: CLAUDE_CONFIG,
    serversPath: ['mcpServers'],
    isInstalled: () => commandExists('claude') || existsSync(CLAUDE_CONFIG),
  },
  {
    name: 'cursor',
    label: 'Cursor',
    configPath: CURSOR_CONFIG,
    serversPath: ['mcpServers'],
    // Cursor creates ~/.cursor on first launch; the binary 'cursor' is also
    // optionally installed. Either one is a real signal.
    isInstalled: () => commandExists('cursor') || existsSync(CURSOR_CONFIG_DIR),
  },
  {
    name: 'cline',
    label: 'Cline',
    // VS Code extension; the MCP file lives under the user's VS Code config.
    // Path varies by OS — this is the macOS default.
    configPath: CLINE_CONFIG,
    serversPath: ['mcpServers'],
    // Only treat Cline as installed when its globalStorage dir exists, which
    // VS Code creates the first time the extension activates.
    isInstalled: () => existsSync(CLINE_GLOBAL_STORAGE),
  },
];

interface RemembrEntry {
  command: string;
  args: string[];
}

const REMEMBR_ENTRY: RemembrEntry = {
  command: 'remembr',
  args: ['serve'],
};

/**
 * Return only the clients whose `isInstalled()` reports true. The probe
 * is per-client (binary on PATH, well-known dotfile, IDE extension dir,
 * …) so we don't false-positive on signals like "homedir exists".
 */
export function detectInstalledClients(clients: McpClient[] = SUPPORTED_CLIENTS): McpClient[] {
  return clients.filter((c) => c.isInstalled());
}

export function installMcpFor(client: McpClient): InstallResult {
  // Read existing config (or {} if missing).
  let existing: Record<string, unknown> = {};
  let preExisted = false;
  if (existsSync(client.configPath)) {
    preExisted = true;
    try {
      existing = JSON.parse(readFileSync(client.configPath, 'utf-8')) as Record<string, unknown>;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        client: client.name,
        configPath: client.configPath,
        status: 'skipped',
        reason: `existing config is not valid JSON: ${message}`,
      };
    }
  }

  // Walk to (and create if needed) the mcpServers container.
  const servers = ensureContainer(existing, client.serversPath);
  const before = servers.remembr;
  const beforeJson = before ? JSON.stringify(before) : null;
  const afterJson = JSON.stringify(REMEMBR_ENTRY);

  if (beforeJson === afterJson) {
    return {
      client: client.name,
      configPath: client.configPath,
      status: 'unchanged',
    };
  }

  servers.remembr = { ...REMEMBR_ENTRY };

  // Backup the original file once before the first write per session.
  if (preExisted) {
    const backupPath = `${client.configPath}.bak-${Date.now()}`;
    try {
      copyFileSync(client.configPath, backupPath);
    } catch {
      // Backup is nice-to-have; don't fail install if it can't be written.
    }
  }

  // Make sure the parent directory exists for clients (e.g. cline) whose
  // config dir might not have been created yet.
  mkdirSync(dirname(client.configPath), { recursive: true });
  writeFileSync(client.configPath, `${JSON.stringify(existing, null, 2)}\n`, 'utf-8');

  if (!preExisted) {
    return { client: client.name, configPath: client.configPath, status: 'created' };
  }
  if (before === undefined) {
    return { client: client.name, configPath: client.configPath, status: 'installed' };
  }
  return { client: client.name, configPath: client.configPath, status: 'updated' };
}

/**
 * Walk `path` inside `root`, creating empty objects for missing keys, and
 * return the leaf object (which we then mutate). The leaf is guaranteed
 * to be a plain object.
 */
function ensureContainer(root: Record<string, unknown>, path: string[]): Record<string, unknown> {
  let cursor = root;
  for (const key of path) {
    const next = cursor[key];
    if (typeof next !== 'object' || next === null || Array.isArray(next)) {
      const fresh: Record<string, unknown> = {};
      cursor[key] = fresh;
      cursor = fresh;
    } else {
      cursor = next as Record<string, unknown>;
    }
  }
  return cursor;
}

export interface RunMcpInstallOptions {
  /** Restrict to a specific client (default: every detected client). */
  client?: ClientName;
  /** When true, also install for clients whose config file doesn't yet exist. */
  all?: boolean;
}

export function runMcpInstall(options: RunMcpInstallOptions = {}): InstallResult[] {
  let candidates: McpClient[];
  if (options.client) {
    const match = SUPPORTED_CLIENTS.find((c) => c.name === options.client);
    if (!match) {
      throw new Error(
        `Unknown client '${options.client}'. Available: ${SUPPORTED_CLIENTS.map((c) => c.name).join(', ')}.`,
      );
    }
    candidates = [match];
  } else if (options.all) {
    candidates = SUPPORTED_CLIENTS;
  } else {
    candidates = detectInstalledClients();
  }

  if (candidates.length === 0) {
    console.log('ℹ No MCP-aware clients detected.');
    console.log('  Run with --all to install for every supported client anyway,');
    console.log('  or with --client <claude-code|cursor|cline> for a specific one.');
    return [];
  }

  const results = candidates.map((c) => installMcpFor(c));

  for (const r of results) {
    const client = SUPPORTED_CLIENTS.find((c) => c.name === r.client);
    const label = client?.label ?? r.client;
    if (r.status === 'unchanged') {
      console.log(`✓ ${label}: already up to date (${r.configPath})`);
    } else if (r.status === 'created') {
      console.log(`✓ ${label}: created config (${r.configPath})`);
    } else if (r.status === 'installed') {
      console.log(`✓ ${label}: added remembr to MCP servers (${r.configPath})`);
    } else if (r.status === 'updated') {
      console.log(`✓ ${label}: updated existing remembr entry (${r.configPath})`);
    } else if (r.status === 'skipped') {
      console.log(`⚠ ${label}: ${r.reason ?? 'skipped'} (${r.configPath})`);
    }
  }

  const installed = results.filter(
    (r) => r.status === 'installed' || r.status === 'created' || r.status === 'updated',
  );
  if (installed.length > 0) {
    console.log('');
    console.log('Restart your MCP client(s) to pick up the change.');
  }

  return results;
}
