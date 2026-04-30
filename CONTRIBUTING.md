# Contributing to remembr

Thanks for considering a contribution. The cheapest, highest-leverage thing
you can do is add a new **source plugin** — every Document plugin makes
remembr more useful for the next person.

## Local setup

```bash
git clone https://github.com/uzayaltiner/remembr.git
cd remembr
npm install

npm run typecheck          # tsc --noEmit
npm run lint               # biome check
npm test                   # vitest, 68 unit tests
npm run dev -- "<query>"   # run CLI from source via tsx
```

The repo uses [Node.js ≥ 20](https://nodejs.org), [tsx](https://tsx.is) for
running TypeScript directly in development, [Biome](https://biomejs.dev)
for lint+format, and [Vitest](https://vitest.dev) for tests.
[better-sqlite3](https://github.com/WiseLibs/better-sqlite3) ships its own
SQLite build with extension support, so no system SQLite is required.

## Project layout

```
src/
├── cli.tsx                Entry point — commander setup + TUI launcher
├── commands/              One file per CLI command
├── config/                ~/.remembr/ paths + JSON config helpers
├── core/
│   ├── embedder/          Embedder interface + transformers.js / ollama backends
│   └── store.ts           better-sqlite3 + sqlite-vec + FTS5 wrapper
├── mcp/                   MCP server + tool handlers (`search`, `list_sources`)
├── plugins/
│   ├── types.ts           Plugin contract — read this first
│   ├── registry.ts        Module-level registry
│   └── <name>/index.ts    One folder per source plugin
├── ui/                    Ink-based interactive TUI (opt-in via no-arg CLI)
└── utils/                 Logger, progress, etc.
tests/                     Mirrors src/ for tests
tests/                     Mirrors src/ for unit tests
```

## Writing a new source plugin

A plugin is a single `Plugin` object exported from `src/plugins/<name>/index.ts`.

```ts
import type { Document, IngestContext, Plugin } from '../types.js';

export const myPlugin: Plugin = {
  name: 'mysource',
  version: '0.1.0',
  description: 'Indexes <data source>.',

  async isAvailable(): Promise<boolean> {
    // return false when the source can't be read on this machine
    return true;
  },

  async *ingest(ctx: IngestContext): AsyncIterable<Document> {
    // yield one Document per item you want indexed
    yield {
      id: 'stable-source-side-id',
      title: 'Display title',
      content: 'Text that will be embedded for retrieval',
      timestamp: Date.now(),
      fingerprint: 'change-detection-token',
      metadata: { /* anything */ },
    };
  },
};
```

Then register it in `src/plugins/index.ts`:

```ts
import { myPlugin } from './mysource/index.js';

export function bootstrapPlugins(): void {
  // ...
  registry.register(myPlugin);
}
```

### Conventions

- **`id`** must be stable across runs for the same logical document. Use a
  file path, URL, or upstream UUID — not anything random.
- **`fingerprint`** is the cheap-to-compute change detector. For files use
  `${mtimeMs}-${size}`; for API objects use `${updatedAt}-${state}`. Same
  fingerprint = skip re-embedding.
- **Yield order** doesn't have to be sorted, but *all chunks of one
  document must yield contiguously* (the index command tracks per-document
  decisions in a `Map`).
- **Errors** thrown from `ingest()` are caught by the runner; per-document
  problems should call `ctx.onProgress` with a `⚠`-prefixed message and
  `continue` instead of throwing.
- **TCC / Full Disk Access** errors should be reraised with a specific
  message — see `src/plugins/apple-notes/index.ts` for the pattern.

### Path-based plugins

If your plugin reads from user-configured directories, name it in
`PATH_BASED_PLUGINS` (currently `'fs'`, `'pdf'`) so `remembr sync --watch`
knows to attach a watcher.

## Pull requests

- One change per PR.
- Run `npm run typecheck && npm run lint && npm test` before opening.
- For new plugins, add at least a parser-level unit test covering the
  fingerprint / parse logic.

## Reporting bugs

Please include:

- macOS version + Node version (`node --version`)
- Output of `remembr status`
- The exact CLI invocation
- The last ~20 lines of `~/.remembr/logs/<today>.log` if it's a runtime
  error (logs are JSONL, redact PII before sharing)
