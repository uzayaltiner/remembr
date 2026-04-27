export interface BrowserHistoryEntry {
  /** Source browser name: 'chrome', 'safari', 'arc', etc. */
  browser: string;
  url: string;
  title: string;
  visitCount: number;
  /** Unix epoch milliseconds. */
  lastVisitTime: number;
}

export interface ReadOptions {
  /** Only include entries newer than this many days. */
  maxAgeDays: number;
  /** Drop entries with fewer visits than this. */
  minVisitCount: number;
}
