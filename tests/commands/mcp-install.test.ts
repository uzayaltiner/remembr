import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type McpClient, installMcpFor } from '../../src/commands/mcp-install.js';

function makeClient(configPath: string): McpClient {
  return {
    name: 'claude-code',
    label: 'Claude Code',
    configPath,
    serversPath: ['mcpServers'],
    isInstalled: () => true,
  };
}

describe('installMcpFor', () => {
  let tmp: string;
  let configPath: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'remembr-mcp-test-'));
    configPath = join(tmp, '.claude.json');
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('creates a fresh config with mcpServers.remembr when none exists', () => {
    const result = installMcpFor(makeClient(configPath));
    expect(result.status).toBe('created');

    const written = JSON.parse(readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
    const servers = written.mcpServers as Record<string, unknown>;
    expect(servers.remembr).toEqual({ command: 'remembr', args: ['serve'] });
  });

  it('preserves unrelated keys when merging into an existing config', () => {
    writeFileSync(
      configPath,
      JSON.stringify({
        somePref: 42,
        mcpServers: {
          'other-server': { command: 'other', args: ['run'] },
        },
      }),
    );

    const result = installMcpFor(makeClient(configPath));
    expect(result.status).toBe('installed');

    const written = JSON.parse(readFileSync(configPath, 'utf-8')) as {
      somePref: number;
      mcpServers: Record<string, unknown>;
    };
    expect(written.somePref).toBe(42);
    expect(written.mcpServers['other-server']).toEqual({ command: 'other', args: ['run'] });
    expect(written.mcpServers.remembr).toEqual({ command: 'remembr', args: ['serve'] });
  });

  it('is idempotent — re-running with the same entry reports unchanged', () => {
    installMcpFor(makeClient(configPath));
    const second = installMcpFor(makeClient(configPath));
    expect(second.status).toBe('unchanged');
  });

  it('updates an existing remembr entry that drifted from the canonical shape', () => {
    writeFileSync(
      configPath,
      JSON.stringify({
        mcpServers: {
          remembr: { command: 'remembr', args: ['serve', '--debug'] },
        },
      }),
    );
    const result = installMcpFor(makeClient(configPath));
    expect(result.status).toBe('updated');
    const written = JSON.parse(readFileSync(configPath, 'utf-8')) as {
      mcpServers: { remembr: unknown };
    };
    expect(written.mcpServers.remembr).toEqual({ command: 'remembr', args: ['serve'] });
  });

  it('skips with a clear reason when the existing config is invalid JSON', () => {
    writeFileSync(configPath, '{ this is not json');
    const result = installMcpFor(makeClient(configPath));
    expect(result.status).toBe('skipped');
    expect(result.reason).toMatch(/not valid JSON/);
  });

  it('writes a backup when the config already existed', () => {
    writeFileSync(configPath, JSON.stringify({ mcpServers: {} }));
    installMcpFor(makeClient(configPath));
    // Hard to assert exact filename (timestamp) so just check the dir for a .bak-* file.
    const fs = readdirSync(tmp);
    expect(fs.some((f) => f.startsWith('.claude.json.bak-'))).toBe(true);
  });

  it('creates parent directories for clients whose config dir does not yet exist', () => {
    const deep = join(tmp, 'nested', 'configs', 'mcp.json');
    const result = installMcpFor(makeClient(deep));
    expect(result.status).toBe('created');
    const written = JSON.parse(readFileSync(deep, 'utf-8')) as {
      mcpServers: { remembr: unknown };
    };
    expect(written.mcpServers.remembr).toBeDefined();
  });
});

// We use a local readdirSync instead of importing 'node:fs' twice to keep
// the import block compact.
import { readdirSync } from 'node:fs';
