# Phase 6 — evidence report (the point of the whole run)

The user must be able to trust the result without re-walking every screen, and to spot-check
any screen in seconds. So: one page, Figma next to the front, per screen, honest status.

## Manifest → generator

Write `.agent/figma-parity/report.json`, then run the skill's own generator (pure Node, no
deps, ships beside this file):

```bash
node <kit>/skills/figma-parity/tools/build-report.mjs .agent/figma-parity/report.json \
     --standalone --out .agent/figma-parity/report.html
```

Without `--standalone` it emits an Artifact-ready fragment (`<title>` + markup, no
doctype/html/body). It embeds every image as a data URI itself — **never read image bytes into
context**. It prints size/counts, lists missing files, and exits 2 if the page exceeds
`--max-bytes` (default 25MB) with the advice to re-capture as JPEG q75 ≤1000px.

Manifest shape (unknown/absent keys are simply skipped):

```jsonc
{
  "title": "...",
  "mode": "AUTO",
  "scale": "PROPORTIONAL k=1.5",
  "date": "...",
  "gate": "...",
  "screens": [
    {
      "name": "Login",
      "status": "ok|decisions|partial|blocked",
      "blockedReason": "...",
      "figmaNode": "1:2",
      "url": "http://…",
      "viewport": "400x900",
      "iterations": 2,
      "score": { "matched": 412, "total": 418, "pct": 98.6 },
      "figma": "shots/login/figma.png",
      "front": "shots/login/after.png",
      "autoFixed": [{ "category": "colour", "count": 4 }],
      "states": [
        {
          "label": "hover",
          "ok": true,
          "figma_value": "#2563eb",
          "front_value": "#2563eb",
          "front": "…png",
        },
      ],
      "motion": [
        {
          "label": "modal",
          "ok": false,
          "figma_value": "250ms ease-out",
          "front_value": "400ms linear",
          "strip": "…png",
        },
      ],
      "data": [{ "label": "long text", "ok": true, "front": "…png" }],
      "decisions": [
        {
          "n": 1,
          "element": "OrderCard (src/…:42)",
          "figma": "3 buttons",
          "front": "2 buttons",
          "kind": "missing",
          "recommend": "FIX",
          "why": "the Retry action is missing",
        },
      ],
      "legit": ["backend data differs"],
      "unverified": ["dark theme — not in the mock"],
      "notes": [],
    },
  ],
  "noToken": [
    {
      "value": "#2563EB",
      "kind": "colour",
      "element": "Button/primary",
      "where": "src/…/theme.ts:88",
      "figmaVariable": "brand/500",
    },
  ],
  "snapped": [
    {
      "category": "font-size",
      "figma": "17px",
      "applied": "16px",
      "why": "dominant 16px — 31 times",
      "where": "CardTitle",
    },
  ],
  "iconsMissing": [
    {
      "name": "ic/heart-outline",
      "node": "12:340",
      "screens": "Catalog",
      "where": "src/…/Card.tsx:57",
    },
  ],
  "askFigma": [
    {
      "page": "Tokens / Colors",
      "why": "check the palette — 6 colours without variables",
      "screens": "Login, Orders",
    },
  ],
  "sweep": {
    "rounds": 2,
    "cappedOut": false,
    "compared": 32,
    "total": 32,
    "confirmed": 9,
    "fixed": 7,
    "escalated": 2,
    "falsePositives": 5,
    "pairs": [
      {
        "id": "login-hover",
        "screen": "Login",
        "kind": "state",
        "figmaNode": "12:340",
        "status": "ok|fixed|escalated|unmapped|no-figma",
        "found": "different icon — replaced",
        "pair": "sweep/login-hover/pair.png",
        "heat": "sweep/login-hover/heat.png",
      },
    ],
    "unmapped": [{ "id": "cart-empty", "why": "the mock has no empty-cart frame" }],
    "falsePositiveRows": [
      {
        "pair": "login-hover",
        "claim": "heading is smaller",
        "refutedBy": "figma 16px = front 16px",
      },
    ],
  },
}
```

`sweep` renders only in STRICT mode (`strict-sweep.md`). Embed `pair`/`heat` **only for pairs
whose status is not `ok`** — 32 side-by-sides as data URIs blow the 25MB cap for no gain; clean
pairs are one text row each, and their PNGs stay on disk where the user can open them.

`score` renders as a chip next to the status and feeds the summary (worst screen, total checks) —
that is what makes "98%" a claim instead of a mood. Definition and thresholds: `scoring.md`.

`noToken` renders as a real swatch palette plus a table — that is the page the user opens next
to Figma's tokens page. `snapped` is the "designer wrote 11 where the file uses 12" log, so an
intentional value can be put back in one line. `askFigma` is the single page-switch request.

The page gives per screen: side-by-side / overlay-with-slider / blink toggle, click-to-zoom at
natural size, state and motion strips with the two values, the decisions table with
FIX / NO FIX / NEEDS BACKEND, legitimate differences, and what stayed unverified. Light and
dark, no external requests.

## Status honesty — the rule that makes the report worth reading

`ok` only if the screen was re-measured after the fixes on the rebuilt stand and every AUTO
item closed by numbers. Anything else is `partial`, `decisions` or `blocked`, with the reason
visible. A screen whose Figma image was unavailable still gets `ok` if the numbers matched —
the comparison images are indicative, the numbers are the verdict; say so.

Never inflate: a masked region, a stubbed data case, a state that could not be reached, a
theme not present in the design — all belong in `unverified`, not in silence.

## Artifact

Publishing uploads product screenshots to claude.ai. So: always write the local
`report.html` first, then offer the artifact in one line and publish only on an explicit yes.
Skip or mask screens the user flagged as containing sensitive/real customer data. Use the
fragment output (no `--standalone`), keep the same file path across redeploys so the URL is
stable, favicon `🎯`.

## Chat answer, and the ONLY question set after Phase 0

Short, Russian: screens by status · autofix counts by category · what stayed unverified and why ·
the single gate result · path to `report.html`. No per-item retelling — that is what the page is
for. STRICT mode adds exactly one line, the sweep coverage:
`compared N/N · confirmed X · fixed Y · escalated Z · false positives W`.

Then, and only then, the decisions. Batch by theme, never per row (≤4 questions, Russian):

- structural diffs — fix all / selected / none;
- colors and values without tokens — turn into variables / keep as values;
- semantically snapped values — keep / restore the literal Figma value;
- Figma pages to open (tokens, icons) — one line.

Row-level detail stays in the report and the decision files; the user answers by theme and
points at exceptions. Skipping the questions is a valid answer — the files stay, and a later
"fix everything" or a targeted list is enough to continue.

If the user answers, apply the accepted rows as a normal follow-up pass and re-verify the
touched screens. Nothing here is applied pre-emptively.
