# Security

What the panel reads, what it writes, what never leaves the machine, and where the trust boundary runs.

🇷🇺 [Русская версия](SECURITY.ru.md) · 📖 [What this project is](../README.md) · 🏗 [How it works](ARCHITECTURE.md) · 📱 [Access from a phone](REMOTE.md)

---

## Security

The tool sits on sensitive files by construction: full access to `~/.claude`, including `.credentials.json` and `.mcp-secrets.env`, plus the ability to spawn processes. It is a single-user tool for your own machine — not a service, not something you expose. Within that model, verified:

**Your keys do not reach git.** A dry run of the commit a contributor would make: `git add -An --all` picks up sources only, the history is clean, and the app writes nothing inside the repository at all — every write path leads to `~/.claude` or `~/.claude-control`. One consequence: chat attachments live in the panel's own folder, so `git add -A` will not sweep them up.

**Nothing is sent anywhere.** No telemetry, no analytics, no error reporting — zero mentions of Sentry, PostHog, GA, Mixpanel or Segment in the code and the lock file; no CDN, no external font, no third-party script on the page. Analytics reads your local transcripts and computes in memory. The server's only outbound request is the MCP handshake with a server you configured yourself. Secrets never reach command-line arguments (the prompt goes through stdin, tokens through the environment), so they are invisible in `ps`. Indirect traffic is expected: `claude` talks to the Anthropic API, `claude plugin` fetches marketplaces, MCP servers do what they do.

**The API is closed to everything but your own UI.** Listening on `127.0.0.1` alone is not enough — a request from a page in your browser already comes from inside the loopback. So CORS is restricted to the panel's own origin (`localhost:8888` / `127.0.0.1:8888`, anything else gets 403 before the handler), requests marked `Sec-Fetch-Site: cross-site` are rejected (that covers forms and `<img>` tags aimed at foreign addresses), and values that end up in CLI arguments (session id, model, chat name, plugin id) are checked against an allowlist rather than escaped — `cmd.exe` quoting rules cannot be trusted. Verified against a live server: with a foreign `Origin`, reading configuration, reading secrets and installing a hook are all refused.

**Remote access is the one deliberate exception, and it is off until you turn it on.** With it on, a request that does not come from the panel's own origin is served only if it carries the Bearer token generated on this machine — shown once as a QR code for the phone, never returned by the API afterwards, revoked by rotating it. The listen address does not change: the tunnel (Tailscale Serve) terminates on the machine itself and proxies to `127.0.0.1`, so nothing is published to the internet and there is no second account system to trust.

> [!IMPORTANT]
> Do not change the listen address to `0.0.0.0`, do not publish the port from a container, do not park the API behind a proxy that drops the token check. With remote access off the API has no authentication by design: whoever reaches it reads your tokens and installs a hook — and a hook is a command Claude Code will run itself. With it on, that token is the only thing standing in the way: keep it inside your own tailnet and rotate it the moment a device is lost.

**Worth knowing.** Sandboxes under `~/.claude-control/sandboxes/` hold a copy of `.credentials.json` and MCP `env` values in plain text; they are deleted on close, and ones abandoned after a crash are swept at the next server start (folders younger than a minute are left alone so two servers starting at once do not fight). Backups of `.mcp-secrets.env` are plain text too, with the original's permissions. `HookProbe.ts` contains a synthetic, non-working `glpat-…` string — bait for verifying that the secret-blocking hook fires. It is not a leak, but GitHub secret scanning will react to it.
