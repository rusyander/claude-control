# Style — precise, no water, in the doc's language

Compression here is not the same as in `agentdeck-kit:doc-hygiene`: a person reads this, so sentences stay
sentences. What gets removed is everything that carries no information.

## Banned — delete on sight

Classes, shown in English — ban the same class in whatever language the doc is written in:

| Banned                                                       | Why                               |
| ------------------------------------------------------------ | --------------------------------- |
| "this document describes…", "this article"                   | the title already said it         |
| "as is well known", "it should be noted", "worth mentioning" | zero information                  |
| "the said", "the above-mentioned", "the following"           | replace with the actual name      |
| "simply", "easily", "just"                                   | false for the reader who is stuck |
| "powerful", "flexible", "modern", "convenient"               | marketing, unverifiable           |
| "planned for the future", "not implemented yet"              | roadmap, not documentation        |
| "approximately", "possibly", "most likely" about a fact      | look it up instead                |
| a heading repeated as the first sentence                     | duplication                       |
| "Introduction", "Conclusion" in a technical doc              | pure padding                      |

## Rules

- One idea per paragraph, ≤3 sentences. Long explanation → break into steps or a table.
- Imperative for instructions: "Run `pnpm dev`", not "You can run".
- Numbers, versions, paths — exact. Absolute dates (`2026-07-25`), never "recently".
- Identifiers, commands, file paths, error text: verbatim, in backticks, never translated.
- Terminology fixed once per project: one term per concept, no synonyms for variety.
- Tables for parameters and options; code blocks for commands; prose only for the "why".
- Every command block is copy-pasteable as-is: no `<your-value>` without saying where to get it.
- Screenshots only when text cannot express it; they rot fastest of all.
- No emoji, no decorative headings, no ASCII art.

## Before / after

BAD:

> In this section we will look at how to start the project. As is well known, modern JavaScript
> applications require Node.js. Simply install the latest version and everything will work.

GOOD:

> Requires Node.js 22.6+ (`.nvmrc` — 22) and pnpm 10.
>
> ```bash
> pnpm install
> pnpm dev        # web :8888, api :5178
> ```

Facts gained: exact versions, exact commands, real ports. Words dropped: most of them.

## Length

≤10 KB per doc is the working target; >25 KB → split by topic. If a doc needs a table of contents
to be usable, it is already two documents.
