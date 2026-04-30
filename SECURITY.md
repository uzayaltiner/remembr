# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in `remembr`, please report it
**privately** so we can fix it before public disclosure.

**Preferred channel:** open a private security advisory on GitHub:

  https://github.com/uzayaltiner/remembr/security/advisories/new

If you cannot use GitHub Security Advisories, email
**uzayaltiner@gmail.com** with subject `remembr-security`.

We aim to acknowledge new reports within **7 days** and to ship a fix or
mitigation within **30 days** for confirmed issues.

## Supported Versions

The current major receives security patches. Older majors receive
critical fixes only. Please update before reporting.

| Version  | Supported |
|----------|-----------|
| 1.x      | ✓         |
| 0.1.x    | critical only |
| < 0.1.0  | ✗         |

## Scope

In scope:

- The `remembr` CLI and the `remembr serve` MCP server
- Default index/config locations under `~/.remembr/`
- Any default-enabled source plugin shipped with the package

Out of scope:

- Vulnerabilities in third-party packages we depend on (please report
  upstream — we will track CVEs and ship updates promptly)
- Local-only data exfiltration that requires the attacker to already
  have shell access as the user
- Security of the user's MCP client (Claude Code, Cursor, Cline, …)

## Privacy

`remembr` indexes potentially sensitive local data (notes, browser
history, mail, calendar). All embeddings and the index live on the
user's machine.

`remembr` itself **never makes calls to remembr-controlled servers**.
Network egress only happens through services the user explicitly opts
into:

- Hugging Face (one-shot embedding-model download on first run; cached
  forever after)
- The `github` plugin shells out to your locally-installed `gh` CLI,
  which talks to api.github.com on your behalf
- The `ollama` provider, when enabled, talks to the Ollama daemon you
  configured (default `http://localhost:11434`)

If you find a code path that violates this — i.e. a default-on plugin
or core component contacting an external service the user did not
opt into — please treat it as a high-severity report.
