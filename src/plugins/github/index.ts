/**
 * GitHub source plugin.
 *
 * Uses the `gh` CLI for authentication + transport — that way we don't have
 * to manage tokens ourselves and we get free pagination, rate-limit handling,
 * and SSO support.
 *
 * Indexed entities:
 *   - Starred repositories (description, topics, language)
 *   - Recent issues involving the user
 *   - Recent pull requests involving the user
 *
 * Plugin config (config.plugins.github):
 *   {
 *     "enabled": true,
 *     "include": ["stars", "issues", "prs"]   // any subset; default = all
 *   }
 *
 * Requires: `gh auth login` to have been run once on this machine.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Document, IngestContext, Plugin } from '../types.ts';

const execFileAsync = promisify(execFile);

const NAME = 'github';
type IncludeKey = 'stars' | 'issues' | 'prs';
const DEFAULT_INCLUDE: IncludeKey[] = ['stars', 'issues', 'prs'];

const STAR_PAGE_SIZE = 100;
const ITEM_LIMIT = 200;

interface GhRepo {
  full_name: string;
  description: string | null;
  html_url: string;
  language: string | null;
  topics: string[];
  stargazers_count: number;
  pushed_at: string;
  fork: boolean;
}

interface GhIssue {
  number: number;
  title: string;
  body: string | null;
  state: string;
  html_url: string;
  repository_url: string;
  updated_at: string;
  user: { login: string } | null;
}

interface GhSearchResponse<T> {
  items: T[];
}

interface GithubPluginConfig {
  enabled: boolean;
  include?: IncludeKey[];
}

export const githubPlugin: Plugin = {
  name: NAME,
  version: '0.1.0',
  description: 'Indexes your GitHub stars + recent issues / PRs (via gh CLI).',

  async isAvailable(): Promise<boolean> {
    try {
      await execFileAsync('gh', ['auth', 'status'], { timeout: 3000 });
      return true;
    } catch {
      return false;
    }
  },

  async *ingest(ctx: IngestContext): AsyncIterable<Document> {
    const config = ctx.config as GithubPluginConfig;
    const include = config.include ?? DEFAULT_INCLUDE;

    if (!(await this.isAvailable())) {
      throw new Error(
        'GitHub CLI is not authenticated.\n  Run: gh auth login\n  See: https://cli.github.com',
      );
    }

    const me = await getCurrentUser();
    ctx.onProgress?.({ current: 0, total: 0, message: `Authenticated as @${me}` });

    let yielded = 0;

    if (include.includes('stars')) {
      for await (const doc of fetchStars(me, ctx)) {
        yielded++;
        yield doc;
      }
    }

    if (include.includes('issues')) {
      for await (const doc of fetchInvolvingItems(me, 'issue', ctx)) {
        yielded++;
        yield doc;
      }
    }

    if (include.includes('prs')) {
      for await (const doc of fetchInvolvingItems(me, 'pr', ctx)) {
        yielded++;
        yield doc;
      }
    }

    ctx.onProgress?.({ current: yielded, total: yielded, message: `GitHub: ${yielded} items` });
  },
};

async function getCurrentUser(): Promise<string> {
  const { stdout } = await execFileAsync('gh', ['api', 'user', '--jq', '.login']);
  return stdout.trim();
}

async function* fetchStars(me: string, ctx: IngestContext): AsyncIterable<Document> {
  let page = 1;
  let totalSeen = 0;
  while (true) {
    const args = [
      'api',
      `users/${me}/starred?per_page=${STAR_PAGE_SIZE}&page=${page}`,
      '--cache',
      '5m',
    ];
    const { stdout } = await execFileAsync('gh', args, { maxBuffer: 16 * 1024 * 1024 });
    const repos = JSON.parse(stdout) as GhRepo[];
    if (repos.length === 0) break;

    for (const repo of repos) {
      totalSeen++;
      yield repoToDocument(repo);
    }

    ctx.onProgress?.({ current: totalSeen, total: 0, message: `stars: ${totalSeen} fetched` });
    if (repos.length < STAR_PAGE_SIZE) break;
    page++;
    if (page > 30) break; // hard ceiling: 3000 stars
  }
}

async function* fetchInvolvingItems(
  me: string,
  kind: 'issue' | 'pr',
  ctx: IngestContext,
): AsyncIterable<Document> {
  // Use the search API: items where the user is involved (author/assignee/mentioned).
  const qualifier = kind === 'pr' ? 'type:pr' : 'type:issue';
  const query = `${qualifier} involves:${me} sort:updated-desc`;
  const args = [
    'api',
    `search/issues?q=${encodeURIComponent(query)}&per_page=100`,
    '--cache',
    '5m',
  ];
  const { stdout } = await execFileAsync('gh', args, { maxBuffer: 16 * 1024 * 1024 });
  const data = JSON.parse(stdout) as GhSearchResponse<GhIssue>;
  const items = (data.items ?? []).slice(0, ITEM_LIMIT);

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (!item) continue;
    yield issueToDocument(item, kind);
    if (i % 25 === 0) {
      ctx.onProgress?.({
        current: i + 1,
        total: items.length,
        message: `${kind}s: ${i + 1}/${items.length}`,
      });
    }
  }
}

function repoToDocument(repo: GhRepo): Document {
  const topicsLine = repo.topics.length > 0 ? `topics: ${repo.topics.join(', ')}\n` : '';
  const langLine = repo.language ? `language: ${repo.language}\n` : '';
  const description = repo.description ?? '(no description)';

  return {
    id: `star:${repo.full_name}`,
    title: `⭐ ${repo.full_name}`,
    content: `${repo.full_name}\n${description}\n${langLine}${topicsLine}${repo.html_url}`,
    url: repo.html_url,
    timestamp: Date.parse(repo.pushed_at) || Date.now(),
    fingerprint: `${repo.pushed_at}-${repo.stargazers_count}`,
    metadata: {
      kind: 'star',
      repository: repo.full_name,
      language: repo.language,
      topics: repo.topics,
      stars: repo.stargazers_count,
      isFork: repo.fork,
    },
  };
}

function issueToDocument(item: GhIssue, kind: 'issue' | 'pr'): Document {
  // repository_url looks like https://api.github.com/repos/owner/name
  const repo = item.repository_url.replace(/^https:\/\/api\.github\.com\/repos\//, '');
  const author = item.user?.login ?? 'unknown';
  const body = item.body ? truncate(item.body, 4000) : '(no body)';
  const icon = kind === 'pr' ? '🔀' : '❗';

  return {
    id: `${kind}:${repo}#${item.number}`,
    title: `${icon} ${repo}#${item.number}: ${item.title}`,
    content: `${repo}#${item.number}\n${item.title}\nby @${author} (${item.state})\n\n${body}\n\n${item.html_url}`,
    url: item.html_url,
    timestamp: Date.parse(item.updated_at) || Date.now(),
    fingerprint: `${item.updated_at}-${item.state}`,
    metadata: {
      kind,
      repository: repo,
      number: item.number,
      state: item.state,
      author,
    },
  };
}

function truncate(text: string, maxLen: number): string {
  return text.length <= maxLen ? text : `${text.slice(0, maxLen - 1)}…`;
}
