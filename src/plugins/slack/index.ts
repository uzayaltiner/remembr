/**
 * Slack source plugin.
 *
 * Reads a Slack workspace export (the ZIP that admins generate from
 * Settings → Workspace → Import/Export Data → Export). The export is a
 * deterministic format we can rely on:
 *
 *   workspace-export/
 *   ├── channels.json     ── list of public channels with id/name/purpose
 *   ├── users.json        ── user id → display name / email
 *   ├── <channel>/
 *   │   ├── 2024-01-01.json
 *   │   ├── 2024-01-02.json
 *   │   └── …
 *   └── …
 *
 * We don't deal with the live Slack API — that needs OAuth and is out of
 * scope for v0.1. Export-based ingestion is privacy-friendly and stable.
 *
 * Plugin config (config.plugins.slack):
 *   { "enabled": true, "paths": ["~/Downloads/myteam-export"] }
 *
 * Either an extracted directory or a .zip file is accepted; .zip is
 * extracted to a temp dir per run.
 */

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import type { Document, IngestContext, Plugin } from '../types.ts';

const execFileAsync = promisify(execFile);

const NAME = 'slack';

interface SlackPluginConfig {
  enabled: boolean;
  paths?: string[];
}

interface SlackIngestOverrides {
  paths?: string[];
}

interface SlackUser {
  id: string;
  name: string;
  real_name?: string;
  profile?: { display_name?: string; real_name?: string; email?: string };
}

interface SlackChannel {
  id: string;
  name: string;
  is_archived?: boolean;
  topic?: { value?: string };
  purpose?: { value?: string };
}

interface SlackMessage {
  type: string;
  subtype?: string;
  user?: string;
  text?: string;
  ts: string; // unix epoch + microseconds, "1234567890.123456"
  thread_ts?: string;
  reply_count?: number;
  bot_id?: string;
  username?: string;
}

export const slackPlugin: Plugin = {
  name: NAME,
  version: '0.1.0',
  description: 'Indexes a Slack workspace export (ZIP or extracted directory).',

  async isAvailable(): Promise<boolean> {
    return true;
  },

  async *ingest(ctx: IngestContext): AsyncIterable<Document> {
    const config = ctx.config as SlackPluginConfig;
    const overrides = (ctx.config._overrides as SlackIngestOverrides | undefined) ?? {};

    const rawPaths = overrides.paths ?? config.paths ?? [];
    const paths = rawPaths.map(expandPath);

    if (paths.length === 0) {
      throw new Error(
        "No paths configured for the 'slack' plugin.\n  Add one: remembr paths add slack ~/Downloads/myteam-export\n  Tip: an admin can generate the export at Settings → Workspace → Import/Export Data.",
      );
    }

    for (const inputPath of paths) {
      const exportRoot = await ensureExtracted(inputPath);
      try {
        for await (const doc of indexExport(exportRoot, ctx)) {
          yield doc;
        }
      } finally {
        // Only clean up dirs we extracted ourselves (those under tmpdir).
        if (exportRoot !== inputPath) rmSync(exportRoot, { recursive: true, force: true });
      }
    }
  },
};

async function ensureExtracted(inputPath: string): Promise<string> {
  if (!existsSync(inputPath)) {
    throw new Error(`Slack export path not found: ${inputPath}`);
  }
  const stat = statSync(inputPath);
  if (stat.isDirectory()) return inputPath;

  if (!inputPath.toLowerCase().endsWith('.zip')) {
    throw new Error(`Expected a directory or .zip file: ${inputPath}`);
  }

  // Use system unzip — it's everywhere and avoids a JS dependency.
  const dest = mkdtempSync(join(tmpdir(), 'remembr-slack-'));
  await execFileAsync('unzip', ['-q', inputPath, '-d', dest]);
  // Slack exports usually wrap the content in a single root folder; find it.
  const entries = readdirSync(dest);
  if (entries.length === 1) {
    const inner = join(dest, entries[0] ?? '');
    if (statSync(inner).isDirectory()) return inner;
  }
  return dest;
}

async function* indexExport(root: string, ctx: IngestContext): AsyncIterable<Document> {
  const users = readUsers(root);
  const channels = readChannels(root);

  const channelDirs = readdirSync(root).filter((name) => {
    const p = join(root, name);
    return statSync(p).isDirectory();
  });

  let totalMessages = 0;
  let yielded = 0;

  for (const channelName of channelDirs) {
    if (ctx.signal?.aborted) return;

    const channelPath = join(root, channelName);
    const channelMeta = channels.get(channelName);
    if (channelMeta?.is_archived) continue;

    const dayFiles = readdirSync(channelPath).filter((f) => f.endsWith('.json'));
    let channelCount = 0;

    for (const dayFile of dayFiles) {
      const filePath = join(channelPath, dayFile);
      let messages: SlackMessage[];
      try {
        messages = JSON.parse(readFileSync(filePath, 'utf-8')) as SlackMessage[];
      } catch {
        continue;
      }

      for (const msg of messages) {
        // Skip system-y messages (joins, leaves, channel-creates) — pure noise
        if (msg.subtype && SKIP_SUBTYPES.has(msg.subtype)) continue;
        if (!msg.text || msg.text.trim().length === 0) continue;

        totalMessages++;
        const author = resolveAuthor(msg, users);
        const text = unmention(msg.text, users);
        const ts = parseTs(msg.ts);

        yielded++;
        yield {
          id: `${channelName}/${msg.ts}`,
          title: `#${channelName}: ${author}`,
          content: `#${channelName} · ${author}\n${text}`,
          timestamp: ts,
          fingerprint: msg.ts,
          metadata: {
            channel: channelName,
            channelTopic: channelMeta?.topic?.value,
            author,
            isThreadParent: msg.reply_count && msg.reply_count > 0,
            isThreadReply: msg.thread_ts && msg.thread_ts !== msg.ts,
          },
        };
      }
      channelCount += messages.length;
    }

    ctx.onProgress?.({
      current: yielded,
      total: 0,
      message: `#${channelName}: ${channelCount} messages`,
    });
  }

  ctx.onProgress?.({
    current: yielded,
    total: totalMessages,
    message: `Slack: ${yielded} messages from ${channelDirs.length} channels`,
  });
}

const SKIP_SUBTYPES = new Set([
  'channel_join',
  'channel_leave',
  'channel_topic',
  'channel_purpose',
  'channel_name',
  'channel_archive',
  'channel_unarchive',
  'bot_add',
  'bot_remove',
  'pinned_item',
  'unpinned_item',
]);

function readUsers(root: string): Map<string, SlackUser> {
  const path = join(root, 'users.json');
  if (!existsSync(path)) return new Map();
  const arr = JSON.parse(readFileSync(path, 'utf-8')) as SlackUser[];
  return new Map(arr.map((u) => [u.id, u]));
}

function readChannels(root: string): Map<string, SlackChannel> {
  const path = join(root, 'channels.json');
  if (!existsSync(path)) return new Map();
  const arr = JSON.parse(readFileSync(path, 'utf-8')) as SlackChannel[];
  return new Map(arr.map((c) => [c.name, c]));
}

function resolveAuthor(msg: SlackMessage, users: Map<string, SlackUser>): string {
  if (msg.username) return msg.username;
  if (msg.bot_id) return `bot:${msg.bot_id}`;
  if (msg.user) {
    const u = users.get(msg.user);
    return u?.profile?.display_name || u?.profile?.real_name || u?.real_name || u?.name || msg.user;
  }
  return 'unknown';
}

/**
 * Replace <@U12345> mentions with @display-name so the embedding sees real
 * names instead of opaque user ids.
 */
function unmention(text: string, users: Map<string, SlackUser>): string {
  return text.replace(/<@([A-Z0-9]+)(?:\|[^>]+)?>/g, (_, id: string) => {
    const u = users.get(id);
    const name = u?.profile?.display_name || u?.real_name || u?.name || id;
    return `@${name}`;
  });
}

function parseTs(ts: string): number {
  const seconds = Number(ts.split('.')[0]);
  return Number.isFinite(seconds) ? seconds * 1000 : Date.now();
}

function expandPath(p: string): string {
  let out = p;
  if (out.startsWith('~')) out = join(homedir(), out.slice(1));
  return isAbsolute(out) ? out : resolve(out);
}
