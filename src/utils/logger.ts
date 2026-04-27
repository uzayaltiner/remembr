/**
 * Lightweight file logger for ~/.remembr/logs/.
 *
 * Goals:
 *  - Capture exceptions and slow paths so users (and us) can debug
 *    failures after the fact.
 *  - Keep stdout clean — logs only ever go to disk unless DEBUG is set.
 *
 * Format: one JSON object per line (newline-delimited). Easy to grep and
 * easy to reason about.
 *
 * Files rotate by date: ~/.remembr/logs/YYYY-MM-DD.log.
 */

import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { PATHS } from '../config/paths.ts';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_RANK: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

function envLevel(): LogLevel {
  const raw = (process.env.BRAIN_LOG_LEVEL ?? '').toLowerCase();
  if (raw === 'debug' || raw === 'info' || raw === 'warn' || raw === 'error') return raw;
  return 'info';
}

const minLevel = envLevel();
const debugStdout = (process.env.BRAIN_DEBUG ?? '') !== '';

function logFilePath(): string {
  const date = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  return join(PATHS.logs, `${date}.log`);
}

function ensureLogsDir(): void {
  try {
    mkdirSync(PATHS.logs, { recursive: true });
  } catch {
    // Best effort — if logs can't be written, we'd rather continue silently
    // than crash the user's session.
  }
}

function write(level: LogLevel, message: string, fields?: Record<string, unknown>): void {
  if (LEVEL_RANK[level] < LEVEL_RANK[minLevel]) return;

  const entry = {
    ts: new Date().toISOString(),
    level,
    msg: message,
    ...fields,
  };
  const line = `${JSON.stringify(entry)}\n`;

  try {
    ensureLogsDir();
    appendFileSync(logFilePath(), line, 'utf-8');
  } catch {
    // swallow — logging must never crash callers
  }

  if (debugStdout) {
    process.stderr.write(line);
  }
}

export const log = {
  debug: (message: string, fields?: Record<string, unknown>): void =>
    write('debug', message, fields),
  info: (message: string, fields?: Record<string, unknown>): void => write('info', message, fields),
  warn: (message: string, fields?: Record<string, unknown>): void => write('warn', message, fields),
  error: (message: string, fields?: Record<string, unknown>): void =>
    write('error', message, fields),
};
