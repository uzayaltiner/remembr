# Changelog

All notable changes to `remembr` are documented here. The format is
loosely based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

## [0.1.0-pre.2] — 2026-04-28

### Added

- **`remembr setup`** — guided one-shot installer. Initialises the config,
  asks which directories to index, walks the user through granting Full
  Disk Access, registers the MCP server with detected clients, and runs
  the first sync. Replaces the old multi-command bring-up.
- **`remembr mcp install [--client <name>] [--all]`** — register the
  remembr MCP server in `~/.claude.json` (Claude Code), `~/.cursor/mcp.json`
  (Cursor), or the Cline settings file. Idempotent, preserves unrelated
  keys, writes a `.bak-<timestamp>` backup.
- **`src/utils/fda.ts`** — Full Disk Access detection by probing the Notes
  database, plus a helper that opens System Settings → Privacy & Security
  via the native deeplink.
- **7 unit tests** for the MCP install JSON-merge logic.

### Fixed

- `remembr init` no longer tells the user to install Ollama. The default
  embedder is `transformers` and needs no external service; the message
  now points at `remembr setup` and `remembr sync`.

## [0.1.0-pre.1] — 2026-04-28

### Changed

- **Runtime: Bun → Node.js ≥ 20.** Distribution is now a standard
  `npm install -g remembr`. No more system SQLite or Bun install for users
  or contributors.
- **Database driver: `bun:sqlite` → `better-sqlite3`.** Vendors its own
  SQLite build with extension support, so sqlite-vec loads without any
  system-sqlite dance. Linux is now genuinely supported alongside macOS.
- **Test runner: `bun:test` → Vitest.** 68 tests, same coverage.
- **TypeScript execution: `bun run` → `tsx` (dev) + `tsc` build to `dist/`
  (publish).** Published tarball ships compiled JS only.
- **CI matrix:** `ubuntu-latest` and `macos-latest` on Node 20 / 22.

## [0.1.0-pre] — 2026-04-28

The first development release. All major surfaces work end-to-end against
real data on macOS but APIs and the wire format are still subject to change.

### Added

- **MCP server** (`remembr serve`) on stdio with `search` and
  `list_sources` tools — works with Claude Code, Cursor, Cline, Continue,
  and any other MCP client.
- **Hybrid search** combining sqlite-vec semantic kNN and FTS5 keyword
  search via Reciprocal Rank Fusion.
- **Multilingual default embedder** — Transformers.js with
  `Xenova/multilingual-e5-small` (q8 quantized, ~30 MB, 100+ languages).
- **Ollama opt-in embedder** for higher-recall models.
- **Bun runtime** with `bun:sqlite` + sqlite-vec + FTS5; the system's
  Homebrew sqlite is loaded at runtime to enable extension support.
- **7 source plugins**:
  - `fs` — Markdown / text / source code (30+ extensions)
  - `browser` — Chrome, Safari, Arc, Brave, Edge, Vivaldi history
  - `pdf` — PDF text extraction
  - `calendar` — Apple Calendar live database (TCC-gated)
  - `mail` — Apple Mail .emlx walker (TCC-gated, 4-way concurrent reads,
    body truncated to 4 KB for tokenizer speed)
  - `apple-notes` — Apple Notes titles + sidebar snippets (TCC-gated)
  - `github` — Stars + recent issues / PRs via authenticated `gh` CLI
- **Incremental indexing** — per-document fingerprints + stale-document
  cleanup. Re-syncing a 6 000-page browser history takes ~150 ms.
- **Watch mode** (`remembr sync --watch`) backed by chokidar for
  path-based plugins.
- **Interactive TUI** at `remembr` (no args) built with Ink.
- **Tolerant `remembr sync`** — every plugin enabled by default; failing
  or unconfigured plugins are skipped with a clear message rather than
  aborting the run.
- **Schema-introspecting Calendar reader** — Apple has shuffled column
  names across macOS releases, so the query is built dynamically from
  PRAGMA table_info().

### Removed

- **Slack plugin (workspace-export based).** Workspace-export Slack only
  works for admins, includes only public channels, and excludes DMs.
  A future OAuth-based replacement is on the roadmap for v0.2.

### Known issues

- Calendar / Mail / Apple Notes need Full Disk Access for the terminal
  app; remembr surfaces the TCC error with a fix prompt.
- Mail first sync runs at ~17 chunks/sec on M-series silicon (ONNX
  inference bound). Subsequent syncs are incremental and take seconds.
- Apple Notes index covers titles + sidebar snippets only — full body
  protobuf decoding is on the v0.3 roadmap.

[Unreleased]: https://github.com/uzayaltiner/remembr/compare/v0.1.0-pre.2...HEAD
[0.1.0-pre.2]: https://github.com/uzayaltiner/remembr/releases/tag/v0.1.0-pre.2
[0.1.0-pre.1]: https://github.com/uzayaltiner/remembr/releases/tag/v0.1.0-pre.1
[0.1.0-pre]: https://github.com/uzayaltiner/remembr/releases/tag/v0.1.0-pre
