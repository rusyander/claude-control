# Providers: panel-side tools

A continuation of [Providers: format details](PROVIDERS.md). That document covers what the panel
edits inside each CLI's files; this one covers the tools that work ON TOP of providers: moving an
environment between machines, the model catalog, the on-your-machine check, the write preview,
configuration comparison, the format check against published schemas, and your own endpoint instead
of the vendor cloud.

🇷🇺 [Русская версия](PROVIDER-TOOLS.ru.md) · 📖 [What this project is](../README.md) ·
🚫 [What the panel does not do](LIMITATIONS.md) · 🔧 [Setup and troubleshooting](SETUP.md)

---

## 1. Moving an environment between machines

Every provider has its own "Export" and "Import" buttons in the Settings section, and each one
works only with itself. Export builds a zip archive: `MANIFEST.json`, `README.md` and the
environment files — instructions, MCP servers, permissions, hooks, skills, agents, commands,
plugins, rules. A preview comes first (how many files, from which directories), the finished
archive path after.

Manifest paths are not absolute: it stores the provider's configuration locations plus relative
names inside them, so an archive made on Windows unpacks on macOS and Linux at their own paths.

There are deliberately no secrets in the archive. Credential and token files (`.credentials.json`,
`.mcp-secrets.env`, `provider-keys.enc`, `*.pem`, `*.key` and the like) never enter it whole; values
under key-looking names (`api_key`, `token`, `secret`, `password`…) are replaced with `__REDACTED__`
in JSON, YAML, TOML and ini. In their place the manifest carries a checklist of what to enter by
hand on the new machine.

Import reads the archive and reports, per file: `new`, `same` (an identical one is already there),
`differs` (will overwrite yours) or `unresolved` (the location could not be resolved). Only new
files are ticked by default. A backup is taken before writing, and the write is atomic. The single
exception to whole-file mode is `~/.claude.json`: only the `mcpServers` key travels, merged, so the
rest of the file is not clobbered.

Heavy or pointless directories are excluded: `projects/`, `todos/`, `history/`, `sessions/`,
`logs/`, `plugins/marketplaces/`, caches, `node_modules`, Python virtual environments (detected by
`pyvenv.cfg`), build folders. Limits: 5 MB per file, 64 MB per archive; files are taken in priority
order (`skills`, `hooks`, `agents`, `commands`, `rules`, `memory` and other essentials first), and
whatever did not fit is listed in the manifest.

## 2. Model catalog

The panel finds out a provider's model list on its own: Settings → the "Provider models" card. The
source is the open [models.dev](https://models.dev/api.json) catalog, the same one OpenCode runs on:
neither Anthropic nor OpenAI nor Google publishes a model list reachable without a key. The request
goes out no more than once a day and the answer is cached in `claude-control/models-cache.json`;
with no network the previous list is shown with its age rather than nothing.

The vendor is declared in `providers/catalog.ts` via `modelVendors`: claude → `anthropic`, codex →
`openai`, gemini → `google`, qwen → `alibaba`, kimi → `moonshotai`, opencode → its own `opencode`
gateway. Continue, Goose, Aider and Cursor deliberately have none: they are harnesses on top of any
model, and the panel will not decide whose list to show (fail-closed).

The default model is moved by the panel itself while the "update the model list automatically"
toggle is on (it is by default). The bounds are narrow: within one family only
(`claude-opus` → `claude-opus`), forward by release date only, and only when a CONCRETE catalog
model is set in the settings. An alias (`opus`), an empty value and an unknown string are left
alone: the CLI already expands an alias to the latest model. A promotion that happened is reported
in the UI.

The panel's built-in assistant (the one filling forms through an API key) lifts its hard-coded model
to the current generation of the same family — the family is the cost guard here: `gpt-mini` stays
`gpt-mini` and never becomes a flagship.

What the panel does NOT read from the catalog: the `experimental` key there describes a model's
experimental modes (a faster one with its own pricing, for instance), not a "preview model", so it
never reaches the UI.

## 3. Provider check

The "experimental" badge means the format comes from the documentation and is covered by tests, but
the panel has never executed it on your machine. The "Run check" button in the settings turns that
promise into a fact: it runs a short checklist here and now.

What is checked:

| Step                | What it proves                                                      |
| ------------------- | ------------------------------------------------------------------- |
| CLI in PATH         | the panel can launch the tool                                       |
| Configuration files | the provider's directory/file is in place                           |
| Section round trip  | the adapter parsed YOUR file, rebuilt it and got the same semantics |
| Assistant launch    | the channel to the model is alive: one short reply arrived          |

**Your files are not modified.** The read-write-read round trip runs on a temporary copy of the
configuration, and the copy is deleted right after. For MCP and environment variables a probe entry
is added to the copy and immediately removed — that exercises both writing and deleting; for
permissions and instructions exactly what was read is written back.

Result: **verified here** — every step passed, including the model reply; **partially verified** —
no failures, but something was skipped (no CLI, or the assistant launch was off); **check failed** —
a step failed and its reason is spelled out. A skipped step counts as neither success nor failure:
in Claude's case, for example, MCP and permissions live on the panel's own routes and the universal
round trip does not apply to them.

The result shows in the provider selector card and as a strip above every section — another CLI's
settings are edited outside the selector page. A check on your machine always outweighs the declared
status, in both directions: a failed check overrides even Claude's "verified".

## 4. Write preview

Another CLI's configuration is written by hand. The panel arrives there as a guest, and the "Save"
button used to show nothing until it was too late. A diff now stands between the button and the file.

It appears on a write into any section of a foreign provider: MCP servers, permissions, environment
variables, instructions. Claude has no preview — it is the panel's default, its formats are verified,
and an extra question on every save would be noise. The "show a diff before writing" toggle in the
settings safety card turns it off; a backup before the write is made independently, that is a
separate setting.

The diff is not a prediction. The panel copies your file into a temporary directory, performs the
**real** write on the copy with the same adapter code, reads the result and deletes the copy. What
you see is exactly what lands in the file. A draft is rejected by the same validation as the write:
if it is invalid, the preview says so and offers no "write anyway" button — otherwise it would be
kinder than the write itself.

The diff can be wider than your edit: the panel re-serialises a whole TOML or JSON region, so a
neighbouring entry may come back spelled differently with the same meaning (`args = ["x"]` →
`args = [ "x" ]`). That is not a bug — but it is better seen before the write, not after.

| Server response       | Meaning                                                  |
| --------------------- | -------------------------------------------------------- |
| `section_unsupported` | the active provider has no such section                  |
| `invalid_draft`       | the draft failed validation — the write would fail too   |
| `format_unrecognized` | the file could not be parsed; the panel will not edit it |

## 5. Comparing configurations and moving entries between CLIs

The "Comparison" section is about two providers at once, so it does not depend on the active one.
The left side defaults to the active CLI, the right side is any other; the panel reads both sides
and shows the difference per section: MCP servers, environment variables, permissions, global
instructions.

The comparison is done **by meaning, not by text**: the same server is written differently in TOML
and in JSON, and a line diff would call everything different. Values are parsed by the adapters and
compared normalised.

What a row can say: `identical` (present on both sides with matching values), `differs` (same name,
different parameters), `left only` / `right only`. Secrets — variables whose name looks like a key
or a token — are shown masked and checked **by presence only**: the panel neither shows nor compares
a secret value.

Permissions are marked "different models": the eight CLIs have different approval models, and
matching key names do not mean matching meaning. They are shown side by side as reference.

### What can be moved

| Section               | Transfer | Why                                                                  |
| --------------------- | -------- | -------------------------------------------------------------------- |
| MCP servers           | yes      | there is a cross-vendor model and real write adapters on both sides  |
| Global instructions   | yes      | it is a plain file: the source text replaces the target text         |
| Environment variables | no       | they hold keys, and the panel writes no secrets into foreign configs |
| Permissions           | no       | translating one approval model into another would be a guess         |

Disabled servers and the `sse` transport are not moved either — other CLIs do not have it. The
reason is printed under the row and the checkbox is disabled: the panel never skips anything
silently.

A transfer always takes two steps: tick the entries → the direction button → the **diff of the
target file**, taken on a temporary copy → "Write". Cancel writes nothing; confirming makes a backup
(if backups are on in the settings). Moving instructions is a copy, not a merge.

## 6. Format check against schemas

The panel writes other CLIs' configuration from their documentation, and documentation drifts with
releases. Everything matches today; two releases later a key has moved — and the person who finds
out is the user whose CLI stopped starting. The "Format check against schemas" card in the settings
asks the same question in advance: are the keys the panel ACTUALLY edits still present in the
officially published schema?

What is compared is **our keys against the schema**, not your file against anything: the check
neither reads nor touches your configuration. A mismatch blocks nothing and fixes nothing — it is a
reason to open the CLI's documentation before the next write into that section.

| State         | What it means                                                                |
| ------------- | ---------------------------------------------------------------------------- |
| `matches`     | every managed key was found in the schema                                    |
| `mismatch`    | some key is missing from the schema — documentation and schema have diverged |
| `no schema`   | this CLI publishes no official schema, so there is nothing to check against  |
| `not checked` | a schema exists but could not be fetched or parsed (network, 404, not JSON)  |

Right now **only OpenCode** is checked: its schema is published at the documented address
`https://opencode.ai/config.json` and appears in the `$schema` of its own configuration examples.
The managed keys are `mcp`, `permission` and `plugin`: exactly what the panel writes is what gets
checked.

**Why this is worth having shows on the very first run.** There used to be a fourth key —
`experimental.hook`, the one OpenCode hooks were built on. The check found it gone from the
published schema: `experimental` lists other keys and its `additionalProperties` is closed, so the
schema rejects such a key outright; the configuration reference confirmed it. The OpenCode hooks
section became read-only (see [format details, §8](PROVIDERS.md)) — on a verifiable fact rather
than on a guess.

The other nine CLIs say "no schema". That is an honest answer rather than "all good": an invented
schema URL would either fail silently or compare the panel against someone else's file and produce
a false "everything matches". Once a schema is published, it goes into the registry in
`domains/format-check.ts` together with the list of keys.

The network is touched at most once a week and never on your path: the section opens from the cache
(`claude-control/format-check.json`), a stale result refreshes in the background, and even a total
network failure yields `not checked` for one provider rather than an error in the panel. "Check
now" is the only place where the answer waits for the network.

## 7. Your own endpoint

An agentic CLI reaches its model at an address, and that address can be changed — to a model inside
your own perimeter, to a company gateway, or to a proxy. It is done through environment variables,
different in every CLI: `ANTHROPIC_BASE_URL`, `GOOGLE_GEMINI_BASE_URL`, `OPENAI_BASE_URL`,
`AIDER_OPENAI_API_BASE`. The "Your own endpoint" card in Settings takes the profile once — address,
API kind, model — and spreads it across the right variables of the CLI you pick with one button.

The API kind is the schema the endpoint accepts requests in, and it follows the endpoint rather than
the CLI: one and the same local model often answers in several schemas at once.

| API kind        | Who it fits                                                                   |
| --------------- | ----------------------------------------------------------------------------- |
| `openai-compat` | llama.cpp, vLLM, Ollama, LM Studio, corporate gateways — nearly all speak it  |
| `anthropic`     | a proxy or gateway on the Anthropic schema; the only kind Claude Code accepts |
| `google`        | a gateway on the Gemini schema                                                |

"Check connection" asks the address for its **model list** (`/v1/models`, `/v1beta/models` or
`/models`, depending on the API kind) and generates nothing: the check is free and burns no tokens.
If a list comes back, the model field turns into a dropdown of what that address actually offers. A
trial answer from the model is the chat's job — a separate action, and a billed one.

Four CLIs accept a profile — the ones whose address variable is documented:

| CLI         | Where it is written                                                                        |
| ----------- | ------------------------------------------------------------------------------------------ |
| Claude Code | `~/.claude/settings.json` → `env`: `ANTHROPIC_BASE_URL`, `ANTHROPIC_MODEL`                 |
| Gemini CLI  | `~/.gemini/.env`: `GOOGLE_GEMINI_BASE_URL`, `GEMINI_MODEL` (`https` only, localhost aside) |
| Qwen Code   | `~/.qwen/.env`: the `OPENAI_*` triple or the `ANTHROPIC_*` one — Qwen takes both kinds     |
| Aider       | `~/.aider.conf.yml` → `set-env`: `AIDER_OPENAI_API_BASE`, `AIDER_MODEL`                    |

Codex and Continue set the model address in their config file only, by hand (`model_providers` in
`config.toml`, and `apiBase` on each model in `config.yaml`); no environment variable for it is
documented, and the panel does not invent one — the row says exactly that. Goose, Kimi Code, Cursor
and OpenCode have no environment-variable section at all.

A separate choice in the same card assigns the profile to the **panel's built-in assistant** — the
one that fills in forms. It writes nothing: the panel calls the address directly, bypassing both the
cloud and the provider CLI. It switches independently of the CLI on purpose: form hints and agent
work are different jobs.

**By default the token never reaches a foreign config.** It is kept encrypted inside the panel
(`provider-keys.enc`, AES-256-GCM) and used for the connection check and by the assistant; only a
mask ever leaves the server. It will land in a CLI file in plain text if you tick "write the token
into the CLI config" — foreign CLIs have no secret store of their own, so this is a deliberate step
with a warning. Without the tick, only the address and the model are written.

The write behaves like every other config edit: a backup, an atomic write, and your other values in
that file are preserved. A CLI session already running will not learn about the change — variables
are read at startup.

Your own address answers the question of WHERE a request goes, not WHAT is in it: if the address is
an external gateway, the data still leaves your perimeter. Substituting names and phone numbers
inside the request is a separate job, and a profile does not solve it.

## 8. Data protection (local proxy)

Your own address decides WHERE a request goes. The "Data protection" section decides WHAT goes in it
— and it works with any address, the vendor cloud included.

The panel raises a listener on `127.0.0.1` (port 5179 by default) and forwards requests upstream
itself. Point a CLI at that address instead of the model address and the panel sees the **body** of
every request: the prompt, the contents of files the agent read, tool output, call arguments. That
is strictly more than a prompt hook sees.

TLS is not intercepted: the CLI talks plain `http` to a local address, and the proxy makes its own
`https` call upstream. No substituted certificates, no trusted roots — the whole setup is one changed
address, most easily via an endpoint profile from §7.

### Rules

| Kind             | What it matches                                                                                                                          |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| built-in pattern | email, phone, INN, SNILS, card number, secret keys; wherever the format has a checksum, it is verified                                   |
| own dictionary   | a list of values (names, projects, addresses): case-insensitive, whole words, Russian inflections covered — "Урманова" matches "Урманов" |
| own expression   | a regular expression; validated before saving                                                                                            |

Checksums matter more than they look: without one, the INN rule would catch any eleven-digit number,
and a false positive in data protection is worse than a miss — it breaks work and teaches people to
switch protection off.

There are three actions. `mask` replaces the value with a `[ИМЯ_1]` placeholder and **restores it in
the model reply** — including a streamed reply where the placeholder is split across frames. `block`
stops the request entirely and hands the CLI a refusal shaped like its own API. `flag` changes
nothing and only writes to the journal — a break-in mode for a new rule.

### What is parsed

| Path                | What the panel rewrites                                                                             |
| ------------------- | --------------------------------------------------------------------------------------------------- |
| `/v1/messages`      | `system`, message texts, tool results, string arguments of tool calls                               |
| `/chat/completions` | message contents and function-call arguments (any OpenAI-compatible gateway)                        |
| everything else     | not parsed — **refused** by default (this includes Gemini: the panel does not parse its body shape) |

Anthropic thinking blocks are never touched: they carry a signature, and editing would break the reply.

### Limits

The proxy finds exactly what the rules describe: it will not guess a surname you did not write down,
and restoration works on exact text — if the model paraphrases the placeholder in its reply, there is
nothing to substitute into and the human sees `[ИМЯ_1]`. No setting publishes the listener outside:
it sees decrypted requests together with keys. The journal holds no values — rule, placeholder and
count only.

Rules live in `<config dir>/claude-control/dlp-rules.json`, apart from `state.json`: their
dictionaries hold real surnames and phone numbers, while panel settings travel between machines by
export. The placeholder vault lives in memory only and is never written to disk.

## 9. Prompt gate (hook)

The third mechanism, the simplest and the most limited: the panel writes a
`claude-control-prompt-gate.mjs` script into the configuration hooks directory and registers it in
`settings.json` on the `UserPromptSubmit` event. The §8 proxy is not needed for this; rules come from
the same `dlp-rules.json` — there is no second dictionary.

The gate sees **only what a human submitted from the input line**. Files the agent read, command
output, tool results and subagent prompts go past it — that is what the proxy sees.

There are two actions: reject the prompt, or warn and send it. The gate cannot replace text with a
placeholder: the `UserPromptSubmit` event cannot rewrite the prompt. That is a limit of Claude Code,
not of the panel. A rule whose own action is `block` stops the prompt even when the shared setting
says "warn" — otherwise that setting would silently downgrade a ban to a notice.

| Situation                     | What the script does                                     |
| ----------------------------- | -------------------------------------------------------- |
| no matches                    | exits 0 silently                                         |
| a match, action "reject"      | writes **rule names** (not values) to stderr and exits 2 |
| a match, action "warn"        | emits a `systemMessage` and lets the prompt through      |
| the rules file is unreadable  | lets the prompt through and says it was **not checked**  |
| the input shape is unfamiliar | the same: doubt is not a reason to block someone's work  |

The script is self-contained: the matching logic is inlined at install time, so it works with the
panel closed. It holds no dictionary — rules are read from disk on every run, otherwise the hook file
would carry personal data along with an environment transfer. A hand-edited script is neither
overwritten nor deleted: the section says so, and restoring the panel's version is a separate button.

The gate is trivial to bypass — the same meaning in other words gets through. It is a barrier against
pasting someone else's data into a prompt by accident, not against a person who wants to send it out.
Real content control is §8.
