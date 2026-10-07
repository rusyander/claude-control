# Phase 5–6 detail: registration, git hygiene, keeping current

## Phase 5 — registration + git hygiene

- **Memory pointer**: short note in project memory ("onboarded, profile at
  `.claude/project-profile.md`, HEAD X") — to remember across chats/sessions.
- **Local-first**: by default add `.claude/project-profile.md` (and generated project rules/hooks)
  to `.git/info/exclude` — lives locally, not committed (same rule as `.agent/`). If the user wants
  to share with the team — on their word keep it in git. **I never run git operations myself.**
- **Doc classification**: agent artifacts (profile, audits, code maps) → `.git/info/exclude`;
  human docs (README/ONBOARDING/ADR) → write properly, user commits (global rule).

## Phase 6 — keep current (incremental)

On notable project changes (new subproject, stack change, new review precedents) — incrementally
extend the profile and refresh HEAD/date. Never re-analyze from scratch. In a known project read
the profile first, then act by it.
