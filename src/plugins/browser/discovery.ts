/**
 * Auto-detect installed browsers on macOS by checking known history paths.
 *
 * Linux paths can be added later — same Chromium schema applies to most
 * Chromium-derived browsers there too.
 */

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

type BrowserType = 'chromium' | 'safari';

export interface BrowserInfo {
  name: string;
  type: BrowserType;
  historyPath: string;
}

const HOME = homedir();

const CANDIDATES: BrowserInfo[] = [
  {
    name: 'chrome',
    type: 'chromium',
    historyPath: join(HOME, 'Library/Application Support/Google/Chrome/Default/History'),
  },
  {
    name: 'arc',
    type: 'chromium',
    historyPath: join(HOME, 'Library/Application Support/Arc/User Data/Default/History'),
  },
  {
    name: 'brave',
    type: 'chromium',
    historyPath: join(
      HOME,
      'Library/Application Support/BraveSoftware/Brave-Browser/Default/History',
    ),
  },
  {
    name: 'edge',
    type: 'chromium',
    historyPath: join(HOME, 'Library/Application Support/Microsoft Edge/Default/History'),
  },
  {
    name: 'vivaldi',
    type: 'chromium',
    historyPath: join(HOME, 'Library/Application Support/Vivaldi/Default/History'),
  },
  {
    name: 'safari',
    type: 'safari',
    historyPath: join(HOME, 'Library/Safari/History.db'),
  },
];

/** Return all browsers whose history files exist on disk. */
export function discoverBrowsers(): BrowserInfo[] {
  return CANDIDATES.filter((b) => existsSync(b.historyPath));
}

/** Lookup a single browser by name. Returns undefined if not installed. */
export function findBrowser(name: string): BrowserInfo | undefined {
  return CANDIDATES.find((b) => b.name === name && existsSync(b.historyPath));
}
