# Toolbelt — commands per dimension per ecosystem

Nothing needs to be preinstalled: JS tools run via `npx -y` / `pnpm dlx` (first run downloads — slow
once, then cached). A tool that cannot run (offline, no runtime, unsupported OS) → the dimension is
SKIPPED with that reason in SUMMARY. Save every raw output to `artifacts/<dimension>.<ext>`.

Monorepo note: run JS tools per workspace package or with the workspace root config; a root-only run
silently misses package-local source roots.

## 1. Vulnerabilities

| Stack  | Command                                                 |
| ------ | ------------------------------------------------------- |
| pnpm   | `pnpm audit --json`                                     |
| npm    | `npm audit --json`                                      |
| Go     | `go run golang.org/x/vuln/cmd/govulncheck@latest ./...` |
| Python | `pipx run pip-audit -f json` (or `python -m pip_audit`) |

## 2. Dependency cycles

| Stack  | Command                                                                                                                                                        |
| ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| JS/TS  | `npx -y madge --circular --extensions ts,tsx,js,jsx <src>` per package. With layer rules: `npx -y dependency-cruiser --no-config --output-type err-long <src>` |
| Go     | import cycles are compile errors — record "clean by compiler"                                                                                                  |
| Python | `pipx run pydeps <pkg> --show-cycles --no-show` (SKIP if graphviz absent)                                                                                      |

## 3. Dead code + unused deps

| Stack  | Command                                                                                                                     |
| ------ | --------------------------------------------------------------------------------------------------------------------------- |
| JS/TS  | `npx -y knip --reporter json` (workspace-aware). Config-less run is noisy — triage before reporting, raw stays in artifacts |
| Go     | `go vet ./...` always; `staticcheck -checks U1000 ./...` when installed, else note                                          |
| Python | `pipx run vulture <src> --min-confidence 80`                                                                                |

## 4. Duplication (language-agnostic)

`npx -y jscpd <src> --reporters json --silent --min-tokens 50` — works on ts/js/go/py alike; one run
per stack root, artifact per run.

## 5. Complexity

| Stack  | Command                                                                                                                                                                                                                                                                                         |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| JS/TS  | `npx -y eslint --no-eslintrc --rule '{"complexity":["warn",10],"max-depth":["warn",4],"max-lines-per-function":["warn",80],"max-params":["warn",4]}' <src> -f json` — TSX needs the project's parser; when config fights, fall back to the 10 largest files by LOC + jscpd stats, swept by hand |
| Go     | `gocyclo -over 15 .` when installed, else SKIP with note                                                                                                                                                                                                                                        |
| Python | `pipx run radon cc -j -n C <src>`                                                                                                                                                                                                                                                               |

## 6. Secrets in the tree

`npx -y secretlint --format json "**/*"` (preset-recommend). Fallback grep sweep:
`(api[_-]?key|secret|token|password)\s*[:=]\s*['"][A-Za-z0-9_\-]{16,}`, AWS `AKIA[0-9A-Z]{16}`,
`-----BEGIN` key headers. Exclude lockfiles and fixtures explicitly marked as test data.

## 7. Licenses

| Stack  | Command                                                                       |
| ------ | ----------------------------------------------------------------------------- |
| JS/TS  | `npx -y license-checker-rseidelsohn --json --summary --production`            |
| Go     | `go-licenses report ./...` when installed, else `go list -m all` + spot-check |
| Python | `pipx run pip-licenses --format=json`                                         |

Copyleft (GPL/AGPL) inside a proprietary app → P2; unknown license → P3 to clarify.

## 8. Outdated majors

`pnpm outdated` / `npm outdated` / `go list -u -m all` / `pipx run pip-review`. Majors behind ≥1 →
P3 list only (executing upgrades belongs to `agentdeck-kit:deps-upgrade`, not this audit).

## 9. Type strictness

- TS: read `tsconfig` — `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`; then
  `npx -y type-coverage --detail=false` (report the % either way; <95 → P3, <85 → P2).
- Python: `mypy`/`pyright` config present and strict-ish; absence itself is a P3 finding.
- Go: typed by construction — record `go vet` result only.
