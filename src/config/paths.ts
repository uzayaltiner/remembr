import { homedir } from 'node:os';
import { join } from 'node:path';

const HOME_OVERRIDE = process.env.REMEMBR_HOME;

export const REMEMBR_HOME = HOME_OVERRIDE ?? join(homedir(), '.remembr');

export const PATHS = {
  home: REMEMBR_HOME,
  config: join(REMEMBR_HOME, 'config.json'),
  database: join(REMEMBR_HOME, 'db.sqlite'),
  logs: join(REMEMBR_HOME, 'logs'),
  plugins: join(REMEMBR_HOME, 'plugins'),
} as const;
