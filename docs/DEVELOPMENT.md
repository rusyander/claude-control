# Development

How the repository is laid out, what verifies a change, and what has to be green before "done".

🇷🇺 [Русская версия](DEVELOPMENT.ru.md) · 📖 [What this project is](../README.md) · 🏗 [How it works](ARCHITECTURE.md) · 🛠 [Troubleshooting](TROUBLESHOOTING.md)

---

## Development

```
apps/
  server/     Fastify API · TypeScript run directly by Node, no build step
  web/        React 19 + Vite · FSD layout, SCSS modules
  mobile/     Expo + React Native · its own toolchain (npm, not the pnpm workspace)
packages/
  contracts/  Shared zod schemas and types
tools/qa/     Playwright scripts — screenshots, layout audit, flow checks
```

| Command                  | What it does                                                                                             |
| ------------------------ | -------------------------------------------------------------------------------------------------------- |
| `pnpm dev`               | Server and frontend together                                                                             |
| `pnpm check`             | The full gate: format, types, lint, module boundaries, build                                             |
| `pnpm type-check`        | TypeScript across all packages                                                                           |
| `pnpm lint`              | ESLint                                                                                                   |
| `pnpm test`              | Vitest for server and web; coverage is measured every run and a drop below the threshold fails it        |
| `pnpm depcruise`         | FSD layer boundaries                                                                                     |
| `pnpm qa:setup`          | Install the Chromium build the QA scripts need (once)                                                    |
| `pnpm keepalive:install` | Watchdog: TCP-probes both ports every 20 s and brings back the half that went silent (`:status`, `:off`) |
| `pnpm mobile`            | Build the phone app and install it on a device or emulator                                               |
| `pnpm mobile:apk`        | Release APK into the repository root                                                                     |
| `pnpm mobile:clean`      | Drop leftover native build intermediates (`--dry` to only measure)                                       |

The phone app has its own chain because Gradle keeps every native library's intermediates inside `node_modules/<package>/android/{build,.cxx}` — about 10 GB per release build, reaching neither the APK nor the repository. `pnpm mobile:apk` wipes them itself once the APK is copied (`--keep-build` keeps them for a faster rebuild); `pnpm mobile:clean` is the manual route.

The same gate runs by itself in two places. A pre-commit hook (husky + lint-staged, installed by `pnpm install`) runs ESLint and a Prettier check on the staged files and rejects a commit that carries CRLF line endings (`tools/check-lf.mjs`). GitHub Actions (`.github/workflows/ci.yml`) repeats format check, types, lint, tests with coverage thresholds and module boundaries on every push and pull request, plus the phone app's type-check and tests; browser QA and the APK build stay local because they need a live panel and a CLI.

QA scripts run against a live panel (`node tools/qa/audit-layout.mjs` and friends); point them elsewhere with `APP_URL`. Accessibility and keyboard: `node tools/qa/check-a11y.mjs` (axe over every section in both themes, create modals included) and `node tools/qa/check-keyboard.mjs` (Tab order, focus ring, Escape and focus return); they share one section list, `tools/qa/panel-pages.mjs` — a new section goes there or the audits never see it. Conditional GET of the chat list is proven by `node tools/qa/check-etag.mjs` (it reads the wire status through CDP, because Playwright reports a 304 revalidation as the cached 200). Internal documentation links are checked by `node tools/check-doc-links.mjs`. FSD layer boundaries are machine-enforced by dependency-cruiser: imports only go downward, cross-feature imports are rejected. The server has no build step — Node runs TypeScript via `--experimental-strip-types`, which is why the Node floor is 22.6 and constructs needing real compilation (parameter properties, enums) are avoided.
