# Contour: a corporate platform behind one key

A contour is the company's platform the panel talks to with a corporate key: its models, embeddings
and agents. The key stays in the panel and agent CLIs are pointed at its local gateway — otherwise a
corporate key would have to be spread across the configurations of nine CLIs, where it can no longer
be taken back.

This document is the overview. The detail lives inside the panel: **Help → Contour** — the whole
path in screenshots of both sides (the company's admin panel and the panel itself), four diagrams,
the refusal table, and the list of signed compromises printed from the registry rather than retyped.

## What works through a contour

| What                                                             | How                              |
| ---------------------------------------------------------------- | -------------------------------- |
| The panel's built-in assistant                                   | works                            |
| Generating test cases, reading runs, translations, summarisation | works                            |
| Analytics and explanations in the panel                          | works                            |
| Embeddings for search                                            | works                            |
| Calling a contour agent (with the company's knowledge and tools) | works                            |
| The MCP bridge: your CLI calls a contour model as a tool         | works                            |
| An agent CLI that edits files                                    | through the shim, with a caveat  |
| An image from a description in chat                              | raster where a model is declared |
| A slide deck on a topic from chat                                | works                            |

## The active contour and the smoke request

Several contours can be connected, but work goes through exactly one — the **active** one. A new
contour becomes active right away, on the wizard's «Done», and the previous one goes dark; the others
read «not active» on their card and carry a «Make it active» button. Switching is one action: the
previous contour's applies are removed (CLI files return to their previous values), its badge goes
out, and its key, budget and settings stay.

Right after activation the panel asks the model a short question itself — through its own local
gateway, the same path a CLI will take. A green line under the address (answer, latency, model)
proves the whole path, not just that the contour is alive. A red one does **not** undo the
activation: a stopped gateway, an exhausted key and a silent model are fixed in different places, and
the cause is spelled out.

«Back to the default provider» removes the applies, clears the badge and leaves the panel and CLIs on
their usual provider. The button sits on the contour card and in «Settings → Models», on the endpoint
profile the contour created itself — it is one and the same action.

## An agent CLI that edits files: through the shim, with a caveat

The platform assembles the tool set itself and drops the client's tools field as an extra key, so a
CLI cannot declare reading a file, editing one, running a command or your MCP servers. The panel
therefore declares those tools to the model as protocol TEXT and assembles the call back out of the
answer, which does give the agent real hands.

The caveat is named rather than hidden: whether the model obeys the protocol is up to the model. A
weaker one describes the action in words instead of calling anything, and the turn then ends
successfully with no file written — the panel flags such a turn on the «Tools through the contour»
card. A call inside a code fence is never executed: a fence is also how a quoted protocol and a
documentation file the agent has just read arrive.

## Images and decks: the panel builds the file

The chat composer has a «Mode» button: an ordinary message to the agent, an image from a
description, or a slide deck on a topic. Both modes work for any CLI and without a contour — only who
draws changes, and the caption under the item says so before you press.

A raster image is asked for by the **panel**, not by the agent — the conversation lives in Claude
Code's own files and the panel writes not one line into them. So the picture is its own request with
its own answer: a card in the conversation's right column and a file in the panel's data folder. It
is not in the thread, and the agent does not know it exists.

Not every contour draws raster, and the server picks the road once: a contour that declares drawing
returns the picture as part of an ordinary answer (through the panel's local gateway, so it is in the
journal; it reaches the key's spend only if the contour sent usage — the company platform does not for an image,
and the journal marks it `usageUnreported` instead of a silent zero); a contour with its own images endpoint uses that, also through the panel gateway (journal, data protection, refusal translation, spend when usage is sent; a paid image is never retried); your endpoint
profile works when its image-generation address field is filled — the address is never guessed from
the base one, because a guess would 404 after you had already described the picture. Otherwise the
conversation's agent draws in code — a vector, not a photo — and what took the raster away is named
next to the item. The mode is locked only when nobody can draw at all: no conversation, no contour,
no endpoint profile.

A deck asks the contour for no capability: the model dictates the slide structure through an
ordinary request, and the panel builds HTML, PPTX and PDF on your machine. Only photographic slide
pictures depend on the contour — they take the same raster road. A sentence around the structure or
`<think>` reasoning before it the panel drops by itself; an answer with no structure at all is named
in the model's own words. In a conversation its agent dictates the deck; a contour or an own endpoint
only outside one.

The bounds are stated: one image at a time, 8 MB per image, the last hundred files on disk, and no
gallery or image history — save what you need with «Download» right away.

Some help screenshots of the shim, images and the red smoke request were taken on a scripted contour
— a stub answering with prepared replies: the company stand has no drawing model, and a small model
does not call tools reliably. Those frames say so in the help.

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
| 402  | The key budget is exhausted. Arrives only for the first half minute — then the same key gets 401. |
| 403  | The key is not allowed the requested model; its name is in the refusal text.                      |
| 404  | Either the model was removed, or the address does not point at the public API. Both are named.    |
| 429  | Too often. The panel retries exactly once and tells you when to retry yourself.                   |
| 451  | The company's content checks stopped the request. Check names are shown, the request text is not. |
| 503  | The contour is still starting — its model registry is not ready.                                  |

The full list of 26 negative scenarios, and what closes each of them, lives in `TASKS-PLATFORM.md` §8
and is verified by `pnpm negatives`.

## How to switch it off

Four different actions, gentlest first:

1. **Untick a consumer** («Configure» → «Where the contour works») — takes effect from the next start,
   the other consumers stay on the contour, no CLI file changes. If that CLI has its files applied, it
   reads the contour address from its own config, and only the next step brings it back.
2. **"Undo the apply"** — the CLI files go back to their previous values and the managed profile
   disappears. The contour stays connected: the panel assistant and the bridge keep working.
3. **"Back to the default provider"** — the contour stops being active, and the gateway answers its
   address with a 502 «contour switched off in the panel». The settings, the key and the spend history
   stay; «Make it active» brings the work back to it.
4. **"Delete the contour"** — asks for the contour's full name; the settings, the key and the probe
   trace are gone, the apply is removed first, automatically.

The "before" copies of every configuration edit live in the History section and outlive the contour;
spend already counted stays too.

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
