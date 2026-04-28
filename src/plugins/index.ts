/**
 * Plugin bootstrap.
 *
 * Importing this module registers all built-in plugins with the global registry.
 * The CLI imports this once at startup; tests can import individual plugins
 * directly to avoid global state.
 */

import { appleNotesPlugin } from './apple-notes/index.js';
import { browserPlugin } from './browser/index.js';
import { calendarPlugin } from './calendar/index.js';
import { fsPlugin } from './fs/index.js';
import { githubPlugin } from './github/index.js';
import { mailPlugin } from './mail/index.js';
import { pdfPlugin } from './pdf/index.js';
import { registry } from './registry.js';

let bootstrapped = false;

export function bootstrapPlugins(): void {
  if (bootstrapped) return;
  bootstrapped = true;

  registry.register(fsPlugin);
  registry.register(browserPlugin);
  registry.register(pdfPlugin);
  registry.register(calendarPlugin);
  registry.register(githubPlugin);
  registry.register(mailPlugin);
  registry.register(appleNotesPlugin);
}

export { registry } from './registry.js';
