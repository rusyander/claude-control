// PreToolUse(Write|Edit): agent docs live in ONE place per repository.
//
// The rule exists because scattered agent docs cost tokens twice: the same knowledge gets
// duplicated across per-package files, and every extra CLAUDE.md in a monorepo is auto-loaded
// on top of the root one. Canonical layout is in doc-policy.mjs (LAYOUT_RULE).
//
// Strict for NEW files (deny — the correct path is unambiguous), asking for files that ALREADY
// exist elsewhere: that is an established project convention, and some projects forbid touching
// these files at all. The answer is remembered per project, so the question is asked once.
// Kill-switch: AGENTDECK_KIT_DOC_LAYOUT=0 (CLAUDE_DOC_LAYOUT=0 honoured), plus the per-project 'off' mode.
import { existsSync } from 'node:fs';
import { isAgentDoc } from './agent-doc.mjs';
import { policyFor, norm, POLICY_STORE_PATH, FIXED_AGENT_NAMES } from './doc-policy.mjs';

export default function agentDocLocation(input) {
  if (process.env.AGENTDECK_KIT_DOC_LAYOUT === '0' || process.env.CLAUDE_DOC_LAYOUT === '0')
    return null;

  const filePath = String(input?.tool_input?.file_path ?? '');
  if (!filePath || !isAgentDoc(filePath)) return null;

  const { root, mode, extraRoots } = policyFor(filePath);
  if (mode === 'off') return null;
  if (!root) return null; // outside a repository — no layout to enforce (global config, memory)

  const p = norm(filePath);
  const rel = p.toLowerCase().startsWith(root.toLowerCase() + '/')
    ? p.slice(root.length + 1)
    : null;
  if (rel === null) return null; // resolved outside its own root — not ours to judge

  const naming = namingViolation(rel);
  if (naming) return naming;
  if (isCanonical(rel, extraRoots)) return null;

  const name = rel.split('/').pop();
  const target = suggest(rel);
  const exists = existsSync(filePath);

  if (exists) {
    return {
      decision: 'ask',
      reason:
        `Agent doc ${rel} sits outside the canonical layout (${root}/CLAUDE.md or AGENTS.md + ${root}/.agent/). ` +
        `The file already exists, so this is the project's own convention, and some projects forbid touching such files. ` +
        `Allow the edit in place? Decline and it moves to ${target}. ` +
        `To stop this question: "keep as is" records the layout as an exception; ` +
        `"hands off this project" turns doc hygiene off for it entirely.`,
    };
  }

  return {
    decision: 'deny',
    reason:
      `[doc-layout] ${name} is a new agent doc outside the canonical layout. Agent material lives in exactly ` +
      `three places per repository: <root>/CLAUDE.md or <root>/AGENTS.md (the only auto-loaded doc — an entry point that points ` +
      `into .agent/), <root>/.agent/ (everything else), <root>/.claude/ (tool config). One of each per repo, ` +
      `monorepo included — a per-package CLAUDE.md is loaded ON TOP of the root one and pays for the same ` +
      `knowledge twice. Write it to ${target} instead. If this project genuinely keeps agent docs elsewhere, ` +
      `ask the user, then record the exception in ${POLICY_STORE_PATH} (extraRoots) or turn hygiene off for ` +
      `this project (mode "off") — see tools/doc-policy-set.mjs.`,
  };
}

// Fixed names inside .agent/ — they are addressed by name from rules and hooks, so a suffix would
// break the references. Everything else carries `.agent.md`: the audience stays visible even if the
// file is later copied, committed, or opened outside the repo.
const FIXED = FIXED_AGENT_NAMES;
// Buffers and dead storage: renaming there buys nothing and rewrites history for no reader.
const EXEMPT_DIRS = /^\.agent\/(tmp|archive|backup|screenshots|\.trash)\//i;

/**
 * Inside .agent/, a doc must be either a fixed name or `<slug>.agent.md`.
 * Returns a deny verdict for a violation, null when the name is fine.
 */
function namingViolation(rel) {
  if (!/^\.agent\//i.test(rel) || !/\.md$/i.test(rel)) return null;
  if (EXEMPT_DIRS.test(rel)) return null;
  const name = rel.split('/').pop();
  if (FIXED.test(name) || /\.agent\.md$/i.test(name)) return null;
  const fixed = rel.replace(/\.md$/i, '.agent.md');
  return {
    decision: 'deny',
    reason:
      `[doc-layout] ${name} sits in .agent/ but does not say so in its name. Agent docs are suffixed ` +
      `\`.agent.md\` so their audience survives being moved, committed, or opened out of context — ` +
      `human docs never carry a suffix, which makes the two sets separable by name alone. ` +
      `Write it to ${fixed} instead. Fixed exceptions (referenced by name): PROGRESS.md, notes.md, ` +
      `ARCHIVE.md, README.md, TASKS.md, glossary.md, and anything under tmp/ archive/ backup/ ` +
      `screenshots/ .trash/.`,
  };
}

/** Canonical: the root entry point, anything under .agent/ or .claude/, plus user-approved roots. */
function isCanonical(rel, extraRoots) {
  const r = rel.toLowerCase();
  // AGENTS.md is an entry point too (Claude Code loads it when there is no CLAUDE.md; every other agent
  // CLI reads it natively). Which name a project uses is the user's answer, not ours —
  // both are canonical AT THE ROOT, and neither is canonical deeper (that is the per-package problem).
  if (r === 'claude.md' || r === 'claude.local.md' || r === 'agents.md' || r === 'agents.local.md')
    return true;
  if (r.startsWith('.agent/') || r.startsWith('.claude/')) return true;
  return extraRoots.some((x) => {
    const e = String(x || '')
      .toLowerCase()
      .replace(/^[./]+|\/+$/g, '');
    return e && (r === e || r.startsWith(e + '/'));
  });
}

/** Where this file should have gone. */
function suggest(rel) {
  const name = rel.split('/').pop();
  if (/^(claude|claude\.local|agents)\.md$/i.test(name))
    return '<root>/CLAUDE.md or <root>/AGENTS.md (merge into the existing one)';
  // Already suffixed → keep it. Appending blindly produced `notes.agent.agent.md`, so the guard's
  // own instruction named a file the naming rule would then reject.
  const target = /\.agent\.md$/i.test(name) ? name : name.replace(/\.md$/i, '.agent.md');
  return `<root>/.agent/${target}`;
}
