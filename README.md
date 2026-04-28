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

# One-time setup
remembr init
remembr status                    # verifies the embedder + sqlite

# Index everything that's ready (runs all 7 sources, skips ones that need config)
remembr sync

# Search
remembr "rust async runtime"

# Or launch the interactive TUI
remembr
```

First sync downloads a ~30 MB multilingual embedding model. Subsequent syncs are incremental and finish in seconds.

---

## Sources

Out of the box, every plugin is enabled. Disable the ones you don't want with `remembr plugins disable <name>`.

| Source | Setup | Notes |
|---|---|---|
| 📄 **fs** | `remembr paths add fs ~/Documents` | Markdown, plain text, source code (30+ extensions) |
| 🌐 **browser** | _automatic_ | Chrome, Safari, Arc, Brave, Edge, Vivaldi history |
| 📕 **pdf** | `remembr paths add pdf ~/Documents/Books` | Indexes the text layer of PDFs |
| 📅 **calendar** | _automatic_ | Apple Calendar live database (needs Full Disk Access) |
| ✉️ **mail** | _automatic_ | Apple Mail messages (needs Full Disk Access) |
| 📝 **apple-notes** | _automatic_ | Apple Notes titles + sidebar snippets (needs FDA) |
| 🐙 **github** | `gh auth login` | Your stars + recent issues / PRs |

Apple Notes / Calendar / Mail need **Full Disk Access** for your terminal app:
System Settings → Privacy & Security → Full Disk Access → add Terminal/iTerm/Warp/Ghostty.

---

## MCP setup (Claude Code, Cursor, Cline, …)

```bash
# Claude Code
claude mcp add --scope user remembr remembr -- serve
```

Or add to `~/.claude.json` directly:

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
remembr init                                Initialize ~/.remembr/
remembr status                              Health check
remembr sync                                Index every enabled source
remembr sync --watch                        Initial sync + live file-watch

remembr search "<query>"                    Hybrid semantic + keyword search
remembr "<query>"                           Shortcut for search
remembr                                     Interactive TUI

remembr plugins list                        Show every plugin + chunk count
remembr plugins enable <name>               Opt-in
remembr plugins disable <name>              Opt-out

remembr paths add <plugin> <dir>            Configure a path-based source
remembr paths list
remembr paths remove <plugin> <dir>

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
│  (Transformers │       │  bun:sqlite +      │
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

- All embeddings run **on your machine**. No data ever leaves the device.
- Configuration + index live in `~/.remembr/`.
- Plugin secrets (e.g. future API tokens) live in `~/.remembr/secrets.json`, ignored by `.gitignore`.
- `remembr` makes **zero outbound network calls** in the default configuration. The first run downloads the embedding model from Hugging Face, then never again.

---

## Roadmap

### v0.1 (current — pre-alpha)

- [x] MCP server + CLI
- [x] Bun + bun:sqlite + sqlite-vec + FTS5
- [x] Hybrid search (RRF)
- [x] Multilingual default embedder
- [x] 7 source plugins
- [x] Incremental indexing + file watcher

### v0.2

- [ ] Slack OAuth (per-user app)
- [ ] iMessage source
- [ ] Apple Notes full body (protobuf decode)
- [ ] Daemon mode (`remembr start` + launchctl)

### v0.3+

- [ ] Voyage / OpenAI embedding providers
- [ ] Reranking pass on top-k
- [ ] Linear / Jira sources
- [ ] Multi-platform (Linux + Windows fs / browser sources)

---

## Contributing

PRs welcome. The cheapest contribution is a new source plugin — see [CONTRIBUTING.md](CONTRIBUTING.md) for the plugin contract.

---

## License

MIT — see [LICENSE](LICENSE).
