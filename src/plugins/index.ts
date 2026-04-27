/**
 * Plugin bootstrap.
 *
 * Importing this module registers all built-in plugins with the global registry.
 * The CLI imports this once at startup; tests can import individual plugins
 * directly to avoid global state.
 */

import { browserPlugin } from './browser/index.ts';
import { fsPlugin } from './fs/index.ts';
import { pdfPlugin } from './pdf/index.ts';
import { registry } from './registry.ts';

let bootstrapped = false;

export function bootstrapPlugins(): void {
  if (bootstrapped) return;
  bootstrapped = true;

  registry.register(fsPlugin);
  registry.register(browserPlugin);
  registry.register(pdfPlugin);
}

export { registry } from './registry.ts';
