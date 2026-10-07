// Project onboarding (SessionStart): when the directory looks like a code project but carries NO
// agent context file, remind the agent once to run the project-onboard skill. Silent when context
// already exists or this is not a project. After onboarding .claude/project-profile.md appears →
// silence.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { instructionChoice } from './doc-policy.mjs';

// Marks of a code project (otherwise stay out — home/temp/empty dirs are skipped).
// Stack-agnostic; .git alone catches almost any repository.
const PROJECT_MARKERS = [
  '.git',
  'package.json',
  'go.mod',
  'go.work',
  'pyproject.toml',
  'requirements.txt',
  'setup.py',
  'Cargo.toml',
  'pom.xml',
  'build.gradle',
  'build.gradle.kts',
  'settings.gradle',
  'composer.json',
  'Gemfile',
  'mix.exs',
  'pubspec.yaml',
  'Package.swift',
  'CMakeLists.txt',
  'Makefile',
  'build.sbt',
  'deno.json',
  'Cargo.lock',
  'go.sum',
];
// Marks that the project already has agent context (then no onboarding is needed)
const AGENT_CONTEXT = [
  '.claude/project-profile.md',
  'CLAUDE.md',
  'CLAUDE.local.md',
  '.claude/CLAUDE.md',
  '.cursor/rules',
  '.cursorrules',
  'AGENTS.md',
  'GEMINI.md',
  'QWEN.md',
  '.github/copilot-instructions.md',
];

/** @returns {string|null} */
export default function projectOnboardCheck(input) {
  const cwd = String(input?.cwd || process.cwd());
  const has = (rel) => existsSync(join(cwd, rel));
  if (!PROJECT_MARKERS.some(has)) return null;
  const out = [];
  if (!AGENT_CONTEXT.some(has)) {
    out.push(
      'Project not onboarded (no project-profile.md / CLAUDE.md / AGENTS.md / .cursor/rules). ' +
        'On the FIRST substantive request — before refactor/audit/tests — run the ' +
        'agentdeck-kit:project-onboard skill: map stack, subprojects, conventions, verify commands, ' +
        'read-only backend zones; materialise .claude/project-profile.md + rules + skill bindings. ' +
        'Do not duplicate existing locations.',
    );
  }
  // Which NAME the instructions live under is a decision: Claude Code reads AGENTS.md in a project
  // with no CLAUDE.md, and every other agent CLI reads AGENTS.md already. So a project still on
  // CLAUDE.md gets the offer ONCE — recorded, then silent forever. Never rename unasked: the name is
  // referenced by docs, guards and code, and a leftover CLAUDE.md silently wins over AGENTS.md.
  if (has('CLAUDE.md') && !has('AGENTS.md') && !instructionChoice(cwd)) {
    out.push(
      'Instructions here live in CLAUDE.md, no AGENTS.md. Claude Code reads AGENTS.md where a ' +
        'project has no CLAUDE.md (settings `instructionFiles`, default `claude-md-or-agents-md`), ' +
        'and the other agent CLIs read AGENTS.md natively. OFFER the user once, when docs are next ' +
        'touched: keep CLAUDE.md, or rename to AGENTS.md so every CLI reads one file. Never rename ' +
        'unasked. State the deciding facts: any CLAUDE.md left in the project silently wins over ' +
        'AGENTS.md; the user-level instruction file is unaffected; references to the name in docs, ' +
        'guards and code are fixed in the same pass. Record the answer: node ' +
        '<kit>/tools/agents-md-choice.mjs "<project-dir>" keep|moved',
    );
  }
  return out.length ? out.join('\n\n') : null;
}
