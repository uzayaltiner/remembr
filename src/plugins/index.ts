/**
 * Plugin bootstrap.
 *
 * Importing this module registers all built-in plugins with the global registry.
 * The CLI imports this once at startup; tests can import individual plugins
 * directly to avoid global state.
 */

import { appleNotesPlugin } from './apple-notes/index.ts';
import { browserPlugin } from './browser/index.ts';
import { calendarPlugin } from './calendar/index.ts';
import { fsPlugin } from './fs/index.ts';
import { githubPlugin } from './github/index.ts';
import { mailPlugin } from './mail/index.ts';
import { pdfPlugin } from './pdf/index.ts';
import { registry } from './registry.ts';

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

export { registry } from './registry.ts';
