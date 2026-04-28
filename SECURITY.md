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

`remembr` is in pre-alpha. Only the most recent `0.1.x` pre-release
receives security patches. Please update before reporting.

| Version  | Supported |
|----------|-----------|
| 0.1.x    | ✓         |
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
user's machine; the project makes **zero outbound network calls** by
default after the first-run embedding-model download. If you find a
code path that violates this guarantee, please treat it as a
high-severity report.
