# Module: frontend security (universal baseline)

Applies to any React/TS project. Client validation is UX, not security: the server always validates.
No PII/secrets/content in logs or errors.

## XSS and markup

- `dangerouslySetInnerHTML` — only for trusted or **sanitised** content (DOMPurify or equivalent).
  Unsanitised user HTML forbidden. Default = text, not innerHTML.
- URLs from data: validate the protocol before `href`/`src` (allow `http/https/mailto/tel`), block
  `javascript:`/`data:` scripts. No user-controlled value in `href` unchecked.

## Links and windows

- External `target="_blank"` → always `rel="noopener noreferrer"` (reverse tabnabbing).

## Secrets and environment

- **No secrets in the frontend bundle.** Only explicitly prefixed vars are public
  (`VITE_*`/`NEXT_PUBLIC_*`); everything else lives on the backend. Env access through a typed config
  module, not `process.env`/`import.meta.env` scattered through the code.
- Tokens: prefer httpOnly cookies over `localStorage` (XSS reads localStorage). Never log tokens.

## Data and messages

- Validate external API responses at the boundary (Zod/valibot) — never trust the data shape (api.md).
- `window.postMessage` — check `event.origin` and the message structure; never send secrets to `*`.

## Execution and CSP

- No `eval`/`new Function`/string `setTimeout` — CSP-friendly and safe.
- Never disable the framework's built-in escaping "to make it work".

## iframe and embedding

- Avoid `<iframe>` where a component would do. Needed → **only with `sandbox`** and minimal
  permissions; NEVER combine `allow-scripts` with `allow-same-origin` (that lifts the sandbox).
- No untrusted/user content in an iframe that executes scripts.
- Embedded HTML/SVG — sanitised only (DOMPurify), scripts stripped.
- Clickjacking protection (`X-Frame-Options: DENY` / CSP `frame-ancestors 'none'`) belongs to the
  backend/proxy/nginx (`deploy/nginx.conf`); never rely on visual hiding in the frontend.

## Dependencies

- New dependency → [[dependency-risk-review]] (health/size/licence/alternatives) + consent.
- Keep the lockfile; periodic `npm audit` / critical-vulnerability updates ([[deps-upgrade]]).

## Redirects and navigation

- Post-login redirect / navigation by a URL/query value → validate against an **allow-list of internal
  paths**; never redirect to an external absolute URL from a parameter (open redirect).
  `window.location = <input>` unchecked is forbidden.

## Data in memory and storage

- No secrets/tokens/PII in `localStorage`/`sessionStorage` (any XSS reads them). A persisted Query cache
  carries no sensitive data unencrypted.
- No PII/secrets/content in console logs.
- Never merge untrusted JSON raw into objects (prototype pollution): safe parsing, `structuredClone`, no
  `Object.assign({}, untrusted)` into shared structures; beware `__proto__`/`constructor` keys.

## Other

- ReDoS: no catastrophic regexes over user input (safe-regex).
- External scripts/styles — avoid; unavoidable → Subresource Integrity (SRI) + exact source in CSP.
- `encodeURIComponent` when building URL/query from data. No `document.write`.

## Static analysis and audit

- SAST aid — **semgrep CLI** (installed; the plugin is disabled):
  `semgrep scan --metrics off --config p/react --config p/typescript <changed paths>`. Measured
  23.09.2026: it caught `dangerouslySetInnerHTML={{ __html: props.h }}` and missed the same sink with a
  destructured typed prop, and `eval(u)` → an aid, never the audit.
- The audit walks this module as a **checklist**: XSS · links/windows · secrets/env · messages/data ·
  execution/CSP · iframe · redirects · storage/logs · dependencies · other.
- **Backend/API read-only** (global rule). Doctrine covers the frontend only; a backend/API finding goes
  into the report, never fixed here. See [[log-forensics]] / [[dependency-risk-review]].

## Red flags

- `dangerouslySetInnerHTML` unsanitised. `target="_blank"` without `rel`. Secret/token in client code or a
  log. `href`/`src` from an unchecked source. `eval`/`new Function`. postMessage without an origin check.
- Open redirect (navigation to an external URL from a parameter). Secret/token/PII in localStorage. ReDoS
  regex on input. External script without SRI. Prototype pollution from untrusted JSON. Editing
  backend/API instead of reporting.
