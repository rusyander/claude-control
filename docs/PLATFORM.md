# Contour: a corporate platform behind one key

A contour is the company's platform the panel talks to with a corporate key: its models, embeddings
and agents. The key stays in the panel and agent CLIs are pointed at its local gateway — otherwise a
corporate key would have to be spread across the configurations of nine CLIs, where it can no longer
be taken back.

This document is the overview. The detail, with diagrams, lives inside the panel: **Help → Contour**
(four diagrams, the refusal table, and the list of signed compromises printed from the registry
rather than retyped).

## What works through a contour

| What                                                             | How   |
| ---------------------------------------------------------------- | ----- |
| The panel's built-in assistant                                   | works |
| Generating test cases, reading runs, translations, summarisation | works |
| Analytics and explanations in the panel                          | works |
| Embeddings for search                                            | works |
| Calling a contour agent (with the company's knowledge and tools) | works |
| The MCP bridge: your CLI calls a contour model as a tool         | works |

## What does not work — and the panel cannot fix it

**An agent CLI (Claude Code, codex, any other) that edits files will not work through a contour.**
The platform assembles the tool set itself — by model, skill and key owner — and runs the tools on
its own side. Its public schema does not accept the client's tools field: it is dropped as an extra
key. So a CLI cannot tell the model about reading a file, editing one, running a command, or your
MCP servers.

There is no honest workaround in the panel. Putting tool descriptions into the request text and
parsing the answer by hand is a homemade protocol on top of a foreign one: it breaks on every model
update, provides neither call identifiers nor parallel calls, and the first wrong parse hands the
agent the right to run something the model never asked for. It is not planned.

A CLI keeps working as an agent through its own usual key — the contour does not stand in the way.
What goes through a contour is the work that needs no tools, plus calls to the platform's own agents.

## Where the key lives

The key is entered once in the wizard and after that lives only on this machine:

- in a separate key-store file inside the panel's working directory, encrypted (AES-256-GCM, the
  passphrase being a machine-local secret in a neighbouring file readable by its owner only);
- it is not in `state.json`, not in the settings backups, not in the environment transfer;
- what goes into a CLI configuration is the local gateway address and a placeholder instead of the
  key (`panel-contour-no-key-needed`); the real key is substituted by the gateway at request time;
- in the panel's own answers the key is always a mask of the form "first characters… last four".

The price of that decision is stated plainly: **while the panel is off, the gateway is closed**, and
a CLI pointed at it gets a connection refusal rather than quietly going to the vendor cloud. That is
a choice for predictability: a corporate request that went somewhere else is worse than any refusal.

## Refusals you will see

| Code | What it means                                                                                     |
| ---- | ------------------------------------------------------------------------------------------------- |
| 401  | The key was not accepted. Five causes the contour does not tell apart: unknown or revoked,        |
|      | expired, budget exhausted, owner deleted, owner check failed. The panel names all five.           |
| 402  | A spend limit — user, team or instance. This is NOT the key's budget.                             |
| 403  | The key is not allowed the requested model; its name is in the refusal text.                      |
| 404  | Either the model was removed, or the address does not point at the public API. Both are named.    |
| 429  | Too often. The panel retries exactly once and tells you when to retry yourself.                   |
| 451  | The company's content checks stopped the request. Check names are shown, the request text is not. |
| 503  | The contour is still starting — its model registry is not ready.                                  |

The full list of 26 negative scenarios, and what closes each of them, lives in `TASKS-ENTERPRISE_PLATFORM.md` §8
and is verified by `pnpm negatives`.

## How to switch it off

Three different actions, gentlest first:

1. **"Remove the apply"** — the CLI files go back to their previous values and the managed profile
   disappears. The contour stays connected.
2. **Switch the contour toggle off** — the gateway stops serving it. The settings, the key and the
   spend history stay.
3. **"Delete the contour"** — the settings, the key and the probe trace are gone; the apply is
   removed first, automatically.

The "before" copies of every configuration edit live in the History section and outlive the contour.

## What the panel does NOT do about a contour

- It changes nothing on the contour's side: neither guardrails, nor tools, nor limits — those are
  configured in the company's admin panel.
- It promises no capability it has not confirmed with a probe: unconfirmed reads "not declared"
  rather than showing a tick.
- It does not fold contour spend into transcript analytics: those are two different figures, and
  ours is an estimate from our own price table, marked with "≈".

## What we ask of the platform team

Some of the limits above are not our choice but a property of somebody else's platform. What we ask
them to publish so those workarounds become unnecessary — and the questions we are left with — is
one page: [docs/PLATFORM-ЗАПРОС.ru.md](PLATFORM-ЗАПРОС.ru.md). It is written in Russian on purpose:
it is a letter to that team, not documentation. Nothing on it blocks the panel.
