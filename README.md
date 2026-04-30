# remembr

> **Recall anything across your tools.** A local-first semantic-search MCP server + CLI that gives Claude Code (and any MCP client) memory beyond your filesystem.

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/runtime-Node%20%E2%89%A5%2020-339933.svg)](https://nodejs.org)
[![MCP](https://img.shields.io/badge/protocol-MCP-9d4edd.svg)](https://modelcontextprotocol.io)

```
$ remembr "italyan yemeği"

📄 cooking-pasta.md                              0.97
   İtalyan Makarnası Pişirme
   "Mükemmel makarna için altın kurallar..."

🌐 youtube.com/.../SpaghettiPuttanesca           0.95
   "BU MAKARNA SOSUNU MUTLAKA DENEYİN..."

📅 2025-11-19 12:00 — Eğitim: Kim Kimdir         0.93
   "Eğitim adı: Kim kimdir, Eğitimen: Bengü..."

✉️ Re: Project pasta meeting                    0.91
   From: ahmet@example.com — "...let's do italian..."
```

Everything runs on your machine. No cloud. No accounts. No telemetry.

---

## Why remembr

Claude Code is great inside your filesystem. But the context you actually need lives elsewhere:

- Notes (Apple Notes, Obsidian, Bear, plain markdown)
- Browser history — that blog post you read last month
- PDFs, books, papers in `~/Documents`
- Calendar events, mail threads
- Code across all your repos

`remembr` indexes **all of it locally** with multilingual semantic embeddings, exposes it over MCP, and lets Claude — or any MCP-aware tool — pull relevant context into a conversation when you ask for it.

---

## Quick start

> Requires macOS (Linux experimental) and [Node.js ≥ 20](https://nodejs.org).

```bash
npm install -g remembr
remembr setup
```

That's it. `remembr setup` walks you through the 3 questions you need to answer (which folders to index, whether to enable the FDA-gated Apple plugins, which MCP client to wire up), grants Full Disk Access, registers itself with Claude Code / Cursor / Cline, and runs the first sync.

After that:

```bash
remembr "rust async runtime"      # search
remembr                           # interactive TUI
remembr sync                      # re-index after data changes
```

First sync downloads a ~30 MB multilingual embedding model. Subsequent syncs are incremental and finish in seconds.

---

## Sources

Out of the box, every plugin is enabled. Disable the ones you don't want with `remembr plugins disable <name>`.

| Source | Setup | Notes |
|---|---|---|
| 📄 **fs** | `remembr paths add fs ~/Documents` | Markdown / plain text by default. Code is opt-in (see below). |
| 🌐 **browser** | _automatic_ | Chrome, Safari, Arc, Brave, Edge, Vivaldi history |
| 📕 **pdf** | `remembr paths add pdf ~/Documents/Books` | Indexes the text layer of PDFs |
| 📅 **calendar** | _automatic_ | Apple Calendar live database (needs Full Disk Access) |
| ✉️ **mail** | _automatic_ | Apple Mail messages (needs Full Disk Access) |
| 📝 **apple-notes** | _automatic_ | Apple Notes titles + sidebar snippets (needs FDA) |
| 🐙 **github** | `gh auth login` | Your stars + recent issues / PRs |

Apple Notes / Calendar / Mail need **Full Disk Access** for your terminal app:
System Settings → Privacy & Security → Full Disk Access → add Terminal/iTerm/Warp/Ghostty.

### Indexing source code with the `fs` plugin

By default `fs` indexes **notes only** (`md`, `markdown`, `mdx`, `txt`, `rst`,
`org`) — most users want remembr to recall what they wrote, not their
lock files. To also index source code, edit `~/.remembr/config.json`:

```json
"fs": {
  "enabled": true,
  "paths": ["/Users/you/Documents"],
  "extensions": [
    "md", "markdown", "mdx", "txt", "rst", "org",
    "ts", "tsx", "js", "jsx", "py", "go", "rs", "swift", "java", "kt"
  ]
}
```

`node_modules`, `dist`, `Pods`, lock files, minified bundles, and the
usual suspects are ignored even when you turn code on.

---

## MCP setup (Claude Code, Cursor, Cline, …)

`remembr setup` registers itself automatically with whatever MCP-aware
clients it detects on your machine. To wire things up later (or from
scratch on a different machine):

```bash
remembr mcp install                       # every detected client
remembr mcp install --client claude-code  # one specific client
```

This merges the entry below into the right config file
(`~/.claude.json`, `~/.cursor/mcp.json`, or the Cline settings file)
without touching your other servers:

```json
{
  "mcpServers": {
    "remembr": {
      "command": "remembr",
      "args": ["serve"]
    }
  }
}
```

Restart your client. Claude will get two tools — `search` and `list_sources` — and pull context from your indexed corpus into conversations:

> _"What did I write about Rust async last month?"_
> _"Show me the calendar events with @ahmet."_
> _"Have I solved this Tokio executor issue before?"_

---

## CLI reference

```
remembr setup                               Guided one-shot setup (recommended)
remembr setup --yes                         Same, accepting every default
remembr setup --reset                       Wipe saved phase state, run all phases

remembr init                                Low-level: create ~/.remembr/ only
remembr status                              Health check
remembr sync                                Index every enabled source
remembr sync --watch                        Initial sync + live file-watch

remembr search "<query>"                    Hybrid semantic + keyword search
remembr "<query>"                           Shortcut for search
remembr                                     Interactive TUI

remembr fda                                 Check Full Disk Access status (macOS)
remembr fda --open                          Same, plus open System Settings

remembr plugins list                        Show every plugin + chunk count
remembr plugins enable <name>               Opt-in
remembr plugins disable <name>              Opt-out

remembr paths add <plugin> <dir>            Configure a path-based source
remembr paths list
remembr paths remove <plugin> <dir>

remembr mcp install                         Register MCP server with detected clients
remembr mcp install --client <name>         Restrict to one (claude-code | cursor | cline)
remembr mcp install --all                   Install for every supported client

remembr config show                         Print current config
remembr config provider <name> [--reset]    Switch embedding provider
remembr config model <name> [--reset]       Switch embedding model

remembr serve                               Start MCP server on stdio
```

---

## Architecture

```
┌─────────────────────────────────────────────┐
│  Claude Code / Cursor / Cline (MCP client)  │
└────────────────────┬────────────────────────┘
                     │ stdio · JSON-RPC
┌────────────────────▼────────────────────────┐
│  remembr serve  (MCP server)                │
│    tools: search · list_sources             │
└────────────────────┬────────────────────────┘
                     │
        ┌────────────┴────────────┐
        ▼                         ▼
┌────────────────┐       ┌────────────────────┐
│  Embedder      │       │  Store             │
│  (Transformers │       │  better-sqlite3 +  │
│   .js / Ollama)│       │  sqlite-vec + FTS5 │
└────────────────┘       └────────┬───────────┘
                                  │
        ┌────────────┬────────────┼────────────┬────────────┐
        ▼            ▼            ▼            ▼            ▼
     fs         browser       calendar       mail        github  …
```

- **Hybrid search** combines vector kNN (semantic) + FTS5 (keyword) via Reciprocal Rank Fusion. You get exact matches when the query has them and semantic recall when it doesn't.
- **Incremental indexing** — every plugin emits a fingerprint per document; unchanged documents are skipped on re-sync. A 6 000-page browser history re-syncs in ~150 ms.
- **Plugin contract** — adding a new source is one file: implement `Plugin.ingest()` to yield `Document`s; the rest of the system (embed, store, search, MCP) is unchanged.

---

## Embedding providers

`remembr` uses [Transformers.js](https://huggingface.co/docs/transformers.js) with `Xenova/multilingual-e5-small` by default — quantized, ~30 MB, 100+ languages, zero setup.

Power users can switch to Ollama for higher recall on a bigger model:

```bash
ollama pull bge-m3
remembr config provider ollama --model bge-m3 --reset
```

API providers (Voyage, OpenAI) are on the roadmap.

---

## Privacy

- All embeddings run **on your machine**. Embeddings, the index, and
  every plugin's intermediate state stay local.
- Configuration + index live in `~/.remembr/` (`0o700`); the config
  file itself is `0o600`.
- API tokens for cloud providers are picked up from environment
  variables / system keychains where applicable. remembr does not
  store secrets in `~/.remembr/` today.
- `remembr` itself **never calls remembr-controlled servers**.
  The only network egress is from services *you* opt into:
  - Hugging Face for the one-shot embedding-model download on first run
    (cached forever after)
  - the `github` plugin, which shells out to your locally-installed
    `gh` CLI to read your stars + recent issues / PRs
  - the `ollama` provider when you switch to it (talks to the Ollama
    daemon you configured)

---

## Roadmap

### Shipped in 0.1

- [x] MCP server + CLI
- [x] Node.js + better-sqlite3 + sqlite-vec + FTS5
- [x] Hybrid search (RRF) — semantic kNN + keyword
- [x] Multilingual default embedder (Transformers.js)
- [x] Ollama opt-in
- [x] 7 source plugins (fs, browser, pdf, calendar, mail, apple-notes, github)
- [x] Incremental indexing + file watcher
- [x] Ink TUI setup with live per-plugin progress bars
- [x] FDA detection + System Settings deeplink
- [x] MCP auto-install for Claude Code / Cursor / Cline
- [x] Claude Code restart from setup

### Next

- [ ] Daemon mode (`remembr start` + launchctl) for automatic re-sync
- [ ] iMessage source
- [ ] Apple Notes full body (protobuf decode)
- [ ] Slack OAuth (per-user app)
- [ ] Voyage / OpenAI embedding providers
- [ ] Reranking pass on top-k
- [ ] Linear / Jira sources
- [ ] Windows support (fs / browser sources)

---

## Contributing

PRs welcome. The cheapest contribution is a new source plugin — see [CONTRIBUTING.md](CONTRIBUTING.md) for the plugin contract.

---

## License

MIT — see [LICENSE](LICENSE).
