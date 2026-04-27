/**
 * Browser history source plugin.
 *
 * Auto-detects installed Chromium-family browsers and Safari, reads their
 * history databases (after copying to a safe temp location), de-duplicates
 * URLs across browsers, and yields one Document per URL.
 *
 * Plugin config (config.plugins.browser):
 *   {
 *     "enabled": boolean,
 *     "browsers": string[],     // optional whitelist; empty = all detected
 *     "maxAgeDays": number,     // default 180
 *     "minVisitCount": number   // default 1
 *   }
 */

import type { Document, IngestContext, Plugin } from '../types.ts';
import { readChromiumHistory } from './chromium.ts';
import { type BrowserInfo, discoverBrowsers, findBrowser } from './discovery.ts';
import { readSafariHistory } from './safari.ts';
import type { BrowserHistoryEntry, ReadOptions } from './types.ts';

const DEFAULTS: ReadOptions = {
  maxAgeDays: 180,
  minVisitCount: 1,
};

const SKIP_SCHEMES = /^(chrome|about|file|view-source|edge|brave|opera|chrome-extension):/i;
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1']);

/**
 * Search engine result pages — pure noise. Their URL contains the query
 * encoded as a parameter, which corrupts embeddings, and the title is just
 * the query echoed back.
 */
const SEARCH_ENGINE_HOSTS = new Set([
  'www.google.com',
  'google.com',
  'www.bing.com',
  'bing.com',
  'duckduckgo.com',
  'www.duckduckgo.com',
  'yandex.com',
  'www.yandex.com',
  'search.brave.com',
]);
const SEARCH_PATHS = /^\/(search|results)\/?/i;

interface BrowserPluginConfig {
  enabled: boolean;
  browsers?: string[];
  maxAgeDays?: number;
  minVisitCount?: number;
}

interface BrowserIngestOverrides {
  browsers?: string[];
  maxAgeDays?: number;
}

export const browserPlugin: Plugin = {
  name: 'browser',
  version: '0.1.0',
  description: 'Indexes browser history (Chrome, Safari, Arc, Brave, Edge, Vivaldi).',

  async isAvailable(): Promise<boolean> {
    return discoverBrowsers().length > 0;
  },

  async *ingest(ctx: IngestContext): AsyncIterable<Document> {
    const config = ctx.config as BrowserPluginConfig;
    const overrides = (ctx.config._overrides as BrowserIngestOverrides | undefined) ?? {};

    const requestedNames = overrides.browsers ?? config.browsers ?? [];
    const browsers = resolveBrowsers(requestedNames);

    if (browsers.length === 0) {
      throw new Error(
        'No supported browsers found.\n  Looked for: Chrome, Safari, Arc, Brave, Edge, Vivaldi.',
      );
    }

    const opts: ReadOptions = {
      maxAgeDays: overrides.maxAgeDays ?? config.maxAgeDays ?? DEFAULTS.maxAgeDays,
      minVisitCount: config.minVisitCount ?? DEFAULTS.minVisitCount,
    };

    // Phase 1: read all browsers, collect entries.
    const allEntries: BrowserHistoryEntry[] = [];
    for (const browser of browsers) {
      try {
        const entries = readBrowser(browser, opts);
        allEntries.push(...entries);
        ctx.onProgress?.({
          current: 0,
          total: 0,
          message: `${browser.name}: ${entries.length} history entries`,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        ctx.onProgress?.({ current: 0, total: 0, message: `⚠ ${browser.name}: ${message}` });
      }
    }

    // Phase 2: dedupe.
    //  - by URL: same URL across browsers → keep most recent
    //  - by title: many sites use the same boilerplate title for tons of pages
    //    (Amazon home redirect SEO title is the worst offender). Keep one
    //    representative URL per title to stop the index from drowning in noise.
    const urlDeduped = dedupeByUrl(allEntries);
    const titleDeduped = dedupeByTitle(urlDeduped);
    const deduped = titleDeduped.filter((e) => isIndexable(e.url));
    const total = deduped.length;
    let current = 0;

    ctx.onProgress?.({ current, total, message: `Yielding ${total} unique URLs` });

    // Phase 3: yield Documents.
    for (const entry of deduped) {
      if (ctx.signal?.aborted) return;
      current++;

      const title = entry.title || hostname(entry.url) || entry.url;
      // Use a clean URL form (host + path, no querystring) for display in
      // the embedding signal. Display URL stays full so the user can click.
      const cleanUrl = stripQuery(entry.url);
      // Many URLs carry a human-readable slug ("/Dyson-Piston-Animal-Süpürge/...")
      // that is the only real description we have when the title is generic.
      const slug = urlSlug(entry.url);
      const embeddingContent = slug ? `${title}\n${slug}\n${cleanUrl}` : `${title}\n${cleanUrl}`;

      yield {
        id: entry.url,
        title,
        content: embeddingContent,
        url: entry.url,
        timestamp: entry.lastVisitTime,
        // Visit count + timestamp: re-index when user has new visits since last run
        fingerprint: `v${entry.visitCount}-${entry.lastVisitTime}`,
        metadata: {
          browser: entry.browser,
          visitCount: entry.visitCount,
        },
      };

      if (current % 200 === 0) {
        ctx.onProgress?.({ current, total, message: `Embedded ${current}/${total}` });
      }
    }
  },
};

function resolveBrowsers(requested: string[]): BrowserInfo[] {
  if (requested.length === 0) return discoverBrowsers();

  const out: BrowserInfo[] = [];
  for (const name of requested) {
    const found = findBrowser(name);
    if (found) out.push(found);
  }
  return out;
}

function readBrowser(browser: BrowserInfo, opts: ReadOptions): BrowserHistoryEntry[] {
  if (browser.type === 'safari') {
    return readSafariHistory(browser.historyPath, opts);
  }
  return readChromiumHistory(browser.historyPath, browser.name, opts);
}

function dedupeByUrl(entries: BrowserHistoryEntry[]): BrowserHistoryEntry[] {
  const map = new Map<string, BrowserHistoryEntry>();
  for (const entry of entries) {
    const existing = map.get(entry.url);
    if (!existing || entry.lastVisitTime > existing.lastVisitTime) {
      map.set(entry.url, entry);
    }
  }
  return Array.from(map.values()).sort((a, b) => b.lastVisitTime - a.lastVisitTime);
}

function isIndexable(url: string): boolean {
  if (!url) return false;
  if (SKIP_SCHEMES.test(url)) return false;

  try {
    const parsed = new URL(url);
    if (LOCAL_HOSTS.has(parsed.hostname)) return false;
    if (parsed.hostname.endsWith('.local')) return false;
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;

    // Drop search-engine results pages — they're query echoes, not content
    if (SEARCH_ENGINE_HOSTS.has(parsed.hostname) && SEARCH_PATHS.test(parsed.pathname)) {
      return false;
    }
  } catch {
    return false;
  }

  return true;
}

function hostname(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

function stripQuery(url: string): string {
  try {
    const u = new URL(url);
    return `${u.hostname}${u.pathname}`.replace(/\/$/, '');
  } catch {
    return url;
  }
}

/**
 * Pull the human-readable parts out of a URL path.
 *
 * `/Dyson-Piston-Animal-Süpürge/dp/B0FZWJ5MFS/ref=sr_1_5`
 *   → "Dyson Piston Animal Süpürge"
 *
 * Skips opaque ids (ASIN, hex hashes, ref tags). When nothing readable is
 * left, returns an empty string.
 */
function urlSlug(url: string): string {
  try {
    const u = new URL(url);
    const segments = u.pathname.split('/').filter((s) => s.length > 0);

    const words = segments
      .filter((s) => !isOpaqueSegment(s))
      .map((s) => decodeURIComponent(s).replace(/[-_+.]/g, ' '))
      .filter((s) => /[a-zçğıöşü]/i.test(s))
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();

    // Less than ~3 chars of slug isn't worth embedding
    return words.length > 3 ? words : '';
  } catch {
    return '';
  }
}

function isOpaqueSegment(segment: string): boolean {
  // ASIN: B0 followed by 8 chars
  if (/^B0[A-Z0-9]{8}$/.test(segment)) return true;
  // ref=… markers
  if (/^ref[=_-]/i.test(segment)) return true;
  // Long all-uppercase / all-digit / hex-ish ids
  if (/^[A-Z0-9]{10,}$/.test(segment)) return true;
  if (/^[a-f0-9]{16,}$/i.test(segment)) return true;
  // Pure numbers
  if (/^\d+$/.test(segment)) return true;
  return false;
}

/**
 * Drop pages that share a title with many others — the title is almost
 * certainly a site-wide SEO boilerplate (Amazon home redirect being the
 * canonical example). Keep one representative URL per title (the shortest,
 * which usually points at the canonical landing page).
 */
function dedupeByTitle(entries: BrowserHistoryEntry[]): BrowserHistoryEntry[] {
  const byTitle = new Map<string, BrowserHistoryEntry>();
  for (const entry of entries) {
    const key = entry.title.trim().toLowerCase();
    if (key.length === 0) continue;
    const existing = byTitle.get(key);
    if (
      !existing ||
      entry.url.length < existing.url.length ||
      (entry.url.length === existing.url.length && entry.lastVisitTime > existing.lastVisitTime)
    ) {
      byTitle.set(key, entry);
    }
  }
  return Array.from(byTitle.values()).sort((a, b) => b.lastVisitTime - a.lastVisitTime);
}
