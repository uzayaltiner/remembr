# localbrain

Your second brain — fully local, terminal-native semantic search across your notes, docs, browser history, and more.

**Privacy-first.** Everything runs on your machine. No cloud. No telemetry. No accounts.

## Status

🚧 **Pre-alpha.** Active development. MVP in progress.

## Vision

```bash
$ brain "rust async runtime karşılaştırması"

📄 rust-research.md            0.89
   "...Tokio production ready, smol minimalist..."

🌐 without.boats/blog/...      0.81
   "...Tokio's executor model differs from..."

💬 Slack #engineering          0.74
   "Ali: tokio vs async-std benchmarks..."
```

## How it works

```
┌─────────────────┐
│  Terminal UI    │  Ink + React
└────────┬────────┘
         │
┌────────▼────────┐
│  Search Engine  │  SQLite + sqlite-vec
└────────┬────────┘
         │
   ┌─────┼─────┬─────┬─────┐
   ▼     ▼     ▼     ▼     ▼
 Markdown Browser Slack Notes ...
```

Each plugin ingests data from a source (your notes, browser history, etc.), generates embeddings via local Ollama, and stores them in SQLite. Search is fully local — no data ever leaves your machine.

## Requirements

- macOS (Linux support coming)
- [Bun](https://bun.sh) >= 1.1 or Node.js >= 20
- [Ollama](https://ollama.com) with `nomic-embed-text` model

## Development

```bash
bun install
bun run dev hello
```

## Roadmap

- [x] Project bootstrap
- [ ] Ollama embedding client
- [ ] SQLite + sqlite-vec store
- [ ] Plugin system
- [ ] Markdown plugin
- [ ] Browser history plugin
- [ ] Ink-based search UI
- [ ] Homebrew distribution

## License

MIT
