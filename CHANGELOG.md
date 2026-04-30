# Changelog

All notable changes to `remembr` are documented here. The format is
loosely based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

## [1.0.0] — 2026-04-30

First stable release. The plugin contract, MCP tool surface, CLI
flags, and on-disk schema are now committed to — breaking changes
will only ship in a future major.

### Added

- **`remembr db repair`** quarantines a corrupt or unreadable
  `~/.remembr/db.sqlite` (and its `-wal` / `-shm` siblings) so the
  next `remembr sync` can rebuild the index from your sources. The
  user's actual data — notes, mail, browser history, … — is never
  touched, so the index is always reproducible.
- **Pre-migration snapshots.** Before applying any schema upgrade
  to an existing index, `remembr` now writes a
  `db.sqlite.pre-v<n>` snapshot via `VACUUM INTO`. A half-completed
  migration leaves a recoverable copy behind.
- **`PRAGMA integrity_check` on open.** Corrupt files surface a
  clear `StoreOpenError` pointing at `remembr db repair` instead of
  a raw better-sqlite3 stack trace.
- **`~/.remembr/sync.lock` advisory lock.** `remembr sync` and
  `remembr index <plugin>` now serialize against each other so two
  parallel write commands can't trample each other's stale-cleanup
  pass. The MCP server (`remembr serve`) stays read-only and is
  intentionally not gated.
- **GitHub issue templates + CODE_OF_CONDUCT.md** for first-time
  contributors.

### Changed

- **`EmbedderConfig.provider` is now `'transformers' | 'ollama'`.**
  The `'voyage'` and `'openai'` slots were typed-permitted but
  threw at runtime in 0.1; they're moved out of the public type
  until they actually ship. Existing config files that pinned them
  fall through to a clear "unknown provider" error.
- **`mcp install` writes are atomic.** Config files (`~/.claude.json`
  and friends) are written to a sibling `.tmp-<pid>-<ts>` and then
  `rename()`d into place. A backup is required to succeed before the
  rename — if the backup fails, the install is aborted. Files larger
  than 50 MB are refused with a friendly message rather than parsed
  and rewritten.
- **Schema migrations are transactional.** Each version step
  (`v1 → v2`, `v2 → v3`) runs inside `db.transaction()`, with the
  matching `PRAGMA user_version` bumped in the same envelope so a
  crash mid-step can't leave a half-applied schema.
- **Per-doc plugin failure isolation.** `mail` and `browser` now
  catch errors per-document inside their iterator and emit a `⚠`
  warning to the progress stream instead of taking the whole plugin
  down. (`fs` and `pdf` already worked this way.)
- **`fs` and `pdf` stream their globs.** Pathological trees with
  millions of paths under user-set roots no longer OOM the process;
  matches are streamed with `globIterate` and capped at 200 000 (fs)
  or 50 000 (pdf).
- **PDF parse timeout.** Each PDF is given a one-minute hard budget;
  malformed files that would otherwise wedge `pdf-parse` are skipped
  with `pdf-parse timed out after 60000ms`.
- **Embedder dimension probe on `Store` open.** Switching to a
  different embedding model without `--reset` now fails fast with a
  helpful message instead of silently inserting mismatched vectors.
- **Embedding-model download has one targeted retry.** Corrupt local
  HF cache from an interrupted download is detected, wiped, and the
  download is retried once. Genuine network failures surface as a
  recoverable `EmbedderError`.
- **macOS-only plugins gate by `process.platform === 'darwin'`.**
  Apple Notes / Calendar / Mail / Claude.app / browser-history all
  short-circuit on Linux and Windows so non-macOS users see "skipped:
  not available" instead of confusing path errors.
- **`remembr index` honours SIGINT.** First Ctrl+C drains the
  in-flight batch, closes the store cleanly, and exits with
  `Indexing aborted by user (SIGINT). Partial progress was saved.`
  A second Ctrl+C falls through to a hard kill.
- **Privacy claim restated.** README + SECURITY.md no longer claim
  zero outbound network calls in absolute terms; instead the
  guarantee is scoped to "no calls to remembr-controlled servers"
  and the user-opt-in egress points (Hugging Face, `gh`, Ollama)
  are listed explicitly.

### Tests

- New: `searchHybrid` RRF semantics (semantic-only, FTS-only,
  fusion ordering, source filter, FTS metachar fallback).
- New: schema migration round-trips (`v1 → v3`, `v2 → v3`,
  idempotent re-open, pre-v snapshot, future-version refusal).
- New: corruption-recovery probe (`Store` of a non-SQLite file
  throws `StoreOpenError` and points at `remembr db repair`).
- New: `acquireWriteLock` create / stale-reclaim / re-entrancy.

## [0.1.0] — 2026-04-29

First public release. The pre-alpha 0.1.0-pre.\* line had a public
GitHub presence but was never tagged as `latest` on npm; this is the
first release that takes that slot.

### Added

- **`remembr setup`** is an Ink TUI: arrow / space / enter prompts
  for paths, Apple plugins, and MCP clients, then a live per-plugin
  progress dashboard during the initial sync.
- **`remembr setup --yes`** runs the same flow headlessly (no TTY
  needed) for CI / scripting.
- **Claude Code lifecycle** — the Done screen detects whether
  Claude.app is running and offers `[r] Restart` or `[o] Open` so the
  user doesn't have to leave the terminal to load the new MCP server.
- **`remembr fda [--open]`** — standalone Full Disk Access status +
  repair flow.
- **`remembr mcp install [--client <name>] [--all]`** — register the
  remembr MCP server with `~/.claude.json`, `~/.cursor/mcp.json`, or
  the Cline settings file. Idempotent, JSON-merge, writes a backup.

### Changed

- **Indexing pipeline runs 2-deep.** While a batch of 32 documents is
  being embedded + written to SQLite, the producer plugin keeps
  yielding to fill the next batch. ~1.5–2× on every plugin.
- **Plugin sync order is explicit** — apple-notes → github → calendar
  → fs → pdf → browser → mail. Cheap plugins finish first so search
  has hits within seconds even on a cold run.
- **`fs` defaults are notes-only** (`md`, `markdown`, `mdx`, `txt`,
  `rst`, `org`). Source code is opt-in via
  `config.plugins.fs.extensions`. `~30` ignore patterns block
  `node_modules`, `.next`, `Pods`, `DerivedData`, every common lock
  file, minified bundles, and source maps. Notes have a 1 MB size
  budget; code has 200 KB.
- **`mail` defaults tightened** — 5000 → 2000 message cap, default
  365-day lookback, Junk / Spam / Trash / Drafts skipped.
- **`browser` defaults tightened** — `maxAgeDays` 180 → 90,
  `minVisitCount` 1 → 2, browser readers run in parallel.
- **`pdf` plugin** runs 3 parses concurrently, ignores the same
  noisy directories as `fs`, caps per-file size at 50 MB.
- **`github` plugin** fans out stars / issues / PRs in parallel.
- **`calendar` plugin** indexes only the last 365 days + next 180
  days by default. Override via `pastDays` / `futureDays`.
- **MCP detection is per-client** — `which claude` for Claude Code,
  `~/.cursor/` for Cursor, VS Code globalStorage dir for Cline. The
  previous "homedir-fallback" was a false-positive on every machine.
- **Setup is a resumable state machine.** Phases (`bootstrap`,
  `paths`, `fda`, `mcp`, `sync`) are persisted in
  `~/.remembr/.setup-state.json`. Re-running setup skips completed
  phases. The most common reason to re-run is FDA: macOS only
  applies new TCC permissions to processes launched AFTER the user
  grants access, so the only correct flow is "exit, restart
  terminal, run setup again".
- **Runtime is Node.js ≥ 20** (was: Bun + system SQLite).
  Distribution is a standard `npm install -g remembr`. Linux is
  genuinely supported alongside macOS in CI.

### Performance

End-to-end first sync on a typical Documents / Mail / Browser load:
**~10 minutes → ~3 minutes** vs the pre-alpha line, driven mostly by
the pipeline change and the per-plugin default tightening.

## [0.1.0-pre.5] — 2026-04-29

### Performance

This release roughly halves end-to-end first-sync time on a typical
machine. Headline change: the indexing pipeline is now 2-deep (one
batch in flight while the next one fills), and every plugin has had
its defaults tightened.

### Changed

- **Indexing pipeline runs 2-deep.** While a batch of 32 documents is
  being embedded + written to SQLite, the producer plugin keeps
  yielding to fill the next batch. Previously every plugin spent
  most of its time blocked on embedder I/O. ~1.5–2× on every plugin.
- **`mail` defaults tightened.**
  - `DEFAULT_MAX_MESSAGES`: 5000 → 2000
  - `DEFAULT_MAX_AGE_DAYS`: 365 (new — only the last year by default)
  - Skip Junk / Spam / Trash / Drafts / Deleted Messages folders
  - Both knobs are configurable via `config.plugins.mail.maxMessages`
    and `config.plugins.mail.maxAgeDays`.
- **`browser` defaults tightened.**
  - `maxAgeDays`: 180 → 90
  - `minVisitCount`: 1 → 2 (drops the long tail of single-click pages)
  - Browser readers run in parallel (`Promise.all`) instead of serially.
- **`pdf` plugin** now runs 3 parses concurrently and ignores the same
  noisy directories as `fs` (`node_modules`, `Pods`, `DerivedData`,
  `dist`, `build`, …). Per-file size cap of 50 MB stops scanned books
  / huge dumps from blocking sync.
- **`github` plugin** fans out stars / issues / PRs in parallel
  (`Promise.all`) instead of running them one after the other.
- **`calendar` plugin** now reads the last 365 days + the next 180 days
  by default. Override with `config.plugins.calendar.pastDays` /
  `futureDays`. The previous "all events ever" default was full of
  10-year-old school events nobody wants in retrieval.

### Notes

Estimated end-to-end first-sync on a typical Documents / Mail / Browser
load: ~10 minutes → ~3 minutes.

## [0.1.0-pre.4] — 2026-04-29

### Changed

- **`fs` defaults are now notes-only.** Indexing 4 000+ `.swift` /
  `.json` / `.yml` files from a checked-out projects folder is almost
  never what the user wants and dominates first-sync time. The default
  extension set is now just `md`, `markdown`, `mdx`, `txt`, `rst`, `org`.
  Code is opt-in via `config.plugins.fs.extensions`.
- **`fs` ignore list expanded ~10×.** Now skips: `.next`, `.nuxt`,
  `.svelte-kit`, `.turbo`, `.cache`, `.parcel-cache`, `coverage`,
  `.nyc_output`, `__pycache__`, `.venv`, `venv`, `env`, `.pytest_cache`,
  `Pods`, `.gradle`, `.idea`, `.vscode`, `vendor`, `bower_components`,
  `DerivedData`, `*.xcworkspace`, `*.xcodeproj`, every common lockfile
  (`package-lock.json`, `pnpm-lock.yaml`, `yarn.lock`, `Cargo.lock`,
  `Gemfile.lock`, `poetry.lock`, `composer.lock`, `*.lockb`),
  minified bundles (`*.min.js`, `*.min.css`, `*.bundle.js`, `*.map`),
  `*.log`, `.DS_Store`, `Thumbs.db`.
- **Per-file size budgets are now per type.** Notes-style files keep
  the previous 1 MB allowance; everything else (code, when explicitly
  enabled) caps at 200 KB. Stops one stray generated artefact from
  blowing up embedding time.

### Performance

- Initial `fs` sync time on a typical `~/Documents` (with checked-out
  projects, books, sample code) drops from ~5 minutes to ~30 seconds.

## [0.1.0-pre.3] — 2026-04-29

### Changed

- **`remembr setup` is now a resumable state machine.** Phases —
  bootstrap, paths, fda, mcp, sync — are tracked in
  `~/.remembr/.setup-state.json`. Re-running `remembr setup` skips
  every phase that's already done. `--reset` wipes the state.
- **FDA flow rewritten to match macOS reality.** Granted permissions
  apply only to processes launched AFTER the user adds the terminal
  to Full Disk Access, so we no longer pretend to wait for an
  in-process update. When FDA is denied, setup opens System Settings,
  prints exact restart instructions, and exits cleanly. The user
  re-launches their terminal and re-runs `remembr setup`, which
  resumes from where it left off.
- **MCP client detection is now signal-based per client.** Claude
  Code: `which claude` or `~/.claude.json`. Cursor: `which cursor`
  or `~/.cursor/`. Cline: VS Code globalStorage extension dir. The
  previous "homedir-as-fallback" check was a false-positive on every
  machine.
- **`remembr init` learned a `quiet` flag.** Setup uses it to suppress
  the trailing "Next steps" hint when init runs as a sub-step.

### Added

- **`remembr fda [--open]`** — standalone Full Disk Access status
  check + repair instructions. Prints the exact macOS restart
  sequence and optionally opens System Settings.
- **`remembr setup --reset`** — wipe phase state and re-run from the
  beginning.
- **`tests/config/setup-state.test.ts`** — 6 tests covering the state
  machine: round-trip, version mismatch, corrupt-file recovery,
  reset, markPhase semantics.

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

[Unreleased]: https://github.com/uzayaltiner/remembr/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/uzayaltiner/remembr/releases/tag/v0.1.0
[0.1.0-pre.5]: https://github.com/uzayaltiner/remembr/releases/tag/v0.1.0-pre.5
[0.1.0-pre.4]: https://github.com/uzayaltiner/remembr/releases/tag/v0.1.0-pre.4
[0.1.0-pre.3]: https://github.com/uzayaltiner/remembr/releases/tag/v0.1.0-pre.3
[0.1.0-pre.2]: https://github.com/uzayaltiner/remembr/releases/tag/v0.1.0-pre.2
[0.1.0-pre.1]: https://github.com/uzayaltiner/remembr/releases/tag/v0.1.0-pre.1
[0.1.0-pre]: https://github.com/uzayaltiner/remembr/releases/tag/v0.1.0-pre
