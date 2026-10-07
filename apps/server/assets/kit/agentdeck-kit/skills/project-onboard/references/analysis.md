# Phase 0-1 detail: skip check + project analysis

## Phase 0 - don't re-analyze; respect existing context

- `.claude/project-profile.md` already exists? Compare its recorded HEAD/date with current:
  no significant changes -> **skip onboarding**, work from the profile. Many changes ->
  **incremental** update (Phase 6), never full re-analysis. (User dislikes re-analysis.)
- Find established context locations and do NOT duplicate them - link instead: root `CLAUDE.md` /
  `.claude/CLAUDE.md`, `.cursor/rules/*`, `AGENTS.md`, `.github/*instructions*`, README/CONTRIBUTING,
  project memory profile (e.g. a `code-style-profile` memory; another project may have none).
  The profile aggregates these by reference, never by copying.

## Phase 1 - analysis (read-only, fact-driven)

Survey broadly from code facts, not guesses. Don't assume the stack - **detect** it:

- **Shape**: monorepo or single package; list of subprojects/services/packages + purpose
  (workspace manifests, service dirs, `go.work` / `pnpm-workspace` / Cargo workspace, etc.).
- **Stack per zone**: manifests define language/framework/versions - `package.json`, `go.mod`,
  `pyproject.toml`/`requirements.txt`, `Cargo.toml`, `pom.xml`/`build.gradle`, `composer.json`,
  `Gemfile`, `*.csproj`/`*.sln`, `mix.exs`, `pubspec.yaml`, `Package.swift`, `CMakeLists.txt`...
  A project may mix several.
- **Structure conventions**: how THIS code is organized (e.g. FSD in a frontend; handler->service->store
  layers in a Go service; src/tests in a Python package; hexagonal...) - read from project docs +
  empirics; never impose a foreign template.
- **Commands**: build, verify/test, run, lint/format, codegen - the ones that actually exist
  (`npm run ...`, `go test ./...`, `pytest`, `cargo test`, `make ...`, `gradle ...`, `dotnet test`...).
  Find them in manifests/`Makefile`/CI configs; don't guess.
- **Ownership zones** (detect, don't assume): what's mine vs foreign/read-only. Global rule
  "backend/DB read-only by default" applies, BUT in a fullstack/solo project (I own everything)
  it may not - determine the actual ownership zone and record explicitly which paths are read-only
  and which are editable. Unclear -> default to cautious (read-only) and ask the user.
- **Glossary seed**: the domain terms the codebase actually runs on — words in entity names, routes
  and table names a newcomer would have to decode. Seed `.agent/glossary.md` (rules: skill
  `agentdeck-kit:doc-hygiene`) only with terms whose meaning is confirmed in code; a guessed glossary is worse
  than none.
- Large/unfamiliar codebases -> read manifests, entry points and one representative file per zone,
  never whole trees. Recon subagents (`readonly-researcher`) only on the user's go-ahead for THIS
  onboarding; they return conclusions, not file dumps.
