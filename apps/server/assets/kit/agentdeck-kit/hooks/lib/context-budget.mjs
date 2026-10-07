// SessionStart: guard on AUTO-LOADED project memory — the one context cost nobody sees.
//
// Everything the harness loads by itself (root CLAUDE.md, its @-imports, per-package CLAUDE.md,
// .claude/rules/**) sits in the cached prefix and is re-billed on EVERY turn of the session.
// Measured before this guard: 30.5k tokens per session in one monorepo (41 rule files), 13.9k in
// another (a 2.5 KB CLAUDE.md @-importing a 40 KB doc), and byte-identical copies of the same
// rules across packages paid for two and three times over.
//
// The hook reads only sizes — zero model tokens — and stays SILENT unless the project is over
// budget or carries exact duplicates. When it speaks it prints ONE capped line: the number, the
// worst offenders, and the remedy (the project's .claude/settings.json → claudeMdExcludes, matched on
// absolute paths). Excluded files are reported too, so a dedup never becomes a silent knowledge
// hole: the canonical copy is named and can be read on demand.
// Only the project's own settings are read: the kit never looks into a home-dir config tree.
// Kill-switch: AGENTDECK_KIT_CTX_BUDGET=0 (CLAUDE_CTX_BUDGET=0 too).
import { readdirSync, statSync, existsSync, readFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { ruleRepeats } from './rule-injector.mjs';
import { sweepState } from './kit-paths.mjs';

const TOK = 4; // bytes per token, English prose
const BUDGET_TOK = 8000; // auto-loaded payload above this is worth a line of context
const MAX_OUT = 420;
const norm = (p) => p.split(sep).join('/');

/** glob-lite → RegExp: ** any depth, * within a segment. Mirrors how picomatch is used here. */
function toRe(pattern) {
  const DOUBLE = String.fromCharCode(0); // placeholder for '**' between the two passes
  const esc = String(pattern).replace(/[.+^${}()|[\]\\]/g, '\\$&');
  const src = esc.replace(/\*\*/g, DOUBLE).replace(/\*/g, '[^/]*').split(DOUBLE).join('.*');
  return new RegExp('^' + src + '$', 'i');
}

/** claudeMdExcludes from the project's own settings files (never a home-dir config). */
function excludesOf(cwd) {
  const out = [];
  for (const name of ['settings.json', 'settings.local.json']) {
    try {
      const s = JSON.parse(readFileSync(join(cwd, '.claude', name), 'utf8'));
      out.push(...(s.claudeMdExcludes || []).map(toRe));
    } catch {
      /* no settings, no exclusions */
    }
  }
  return out;
}

/** @returns {string|null} one capped line, or null when the project is within budget. */
export default function contextBudget(input) {
  if (process.env.AGENTDECK_KIT_CTX_BUDGET === '0' || process.env.CLAUDE_CTX_BUDGET === '0')
    return null;
  const cwd = String(input?.cwd || process.cwd());
  const excludeRes = excludesOf(cwd);
  const excluded = (abs) => excludeRes.some((re) => re.test(norm(abs)));

  const loaded = []; // {p, size}
  const skipped = []; // excluded by policy — reported, never silently dropped

  function add(abs) {
    try {
      const size = statSync(abs).size;
      (excluded(abs) ? skipped : loaded).push({ p: norm(abs), size });
    } catch {
      /* gone */
    }
  }

  /** @-imports declared inside a memory file (one level: that is what the loader itself follows). */
  function imports(abs) {
    try {
      for (const m of readFileSync(abs, 'utf8').matchAll(/^@([^\s]+)/gm)) {
        const t = join(abs, '..', m[1]);
        if (existsSync(t)) add(t);
      }
    } catch {
      /* unreadable */
    }
  }

  function scanRoot(dir) {
    // A directory with no CLAUDE.md is loaded from AGENTS.md instead (Claude Code's default
    // `instructionFiles: claude-md-or-agents-md`; every other CLI reads AGENTS.md natively), so the
    // budget follows the same order — counting a file the harness will NOT load would make it lie.
    const md = [join(dir, 'CLAUDE.md'), join(dir, 'AGENTS.md')].find((p) => existsSync(p));
    if (md) {
      add(md);
      imports(md);
    }
    const rules = join(dir, '.claude', 'rules');
    if (existsSync(rules)) {
      try {
        for (const f of readdirSync(rules)) if (/\.md$/i.test(f)) add(join(rules, f));
      } catch {
        /* unreadable */
      }
    }
  }

  try {
    scanRoot(cwd);
    for (const e of readdirSync(cwd, { withFileTypes: true })) {
      if (e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules')
        scanRoot(join(cwd, e.name));
    }
  } catch {
    return null;
  }
  // Rules delivered twice inside one session: the other context cost nobody sees.
  let repeatLine = null;
  try {
    repeatLine = ruleRepeats();
  } catch {
    /* the budget line must not depend on the injector */
  }
  // Session stamps outlive their sessions: a week-old stamp belongs to a finished session.
  for (const sub of ['stamps', 'rules', 'sessions']) sweepState(sub);
  if (!loaded.length && !skipped.length && !repeatLine) return null;

  const bytes = loaded.reduce((s, x) => s + x.size, 0);
  const tok = Math.round(bytes / TOK);

  // Exact duplicates among what IS loaded: the same knowledge billed twice, fixable with zero loss.
  const byHash = {};
  for (const x of loaded) {
    try {
      const h = createHash('md5').update(readFileSync(x.p)).digest('hex');
      (byHash[h] ??= []).push(x);
    } catch {
      /* skip */
    }
  }
  const dupes = Object.values(byHash).filter((g) => g.length > 1);
  const dupTok = Math.round(
    dupes.reduce((s, g) => s + g.slice(1).reduce((a, x) => a + x.size, 0), 0) / TOK,
  );

  const out = [];
  if (repeatLine) out.push(repeatLine);
  if (tok > BUDGET_TOK) {
    // Paths relative to cwd: three files called 03-code-standards.md say nothing without their package.
    const rel = (p) =>
      p.toLowerCase().startsWith(norm(cwd).toLowerCase() + '/') ? p.slice(cwd.length + 1) : p;
    const top = [...loaded]
      .sort((a, b) => b.size - a.size)
      .slice(0, 3)
      .map((x) => `${rel(x.p)} ${Math.round(x.size / TOK / 100) / 10}k`)
      .join(', ');
    // Upper bound: per-package memory loads only when a file in that package is touched.
    out.push(
      `auto-loaded memory here: up to ≈${Math.round(tok / 100) / 10}k tok/turn (${loaded.length} files): ${top}`,
    );
  }
  if (dupTok > 500) {
    out.push(
      `${dupes.length} byte-identical copies ≈${Math.round(dupTok / 100) / 10}k tok — dedup via claudeMdExcludes in the project's .claude/settings.json`,
    );
  }
  if (skipped.length) {
    const canon = [...new Set(skipped.map((x) => x.p.replace(/[^/]+$/, '')))];
    const keep = loaded.filter((x) =>
      skipped.some((s) => s.p.split('/').pop() === x.p.split('/').pop()),
    );
    out.push(
      `${skipped.length} duplicate doc(s) excluded from auto-load (saved ≈${Math.round(skipped.reduce((s, x) => s + x.size, 0) / TOK / 100) / 10}k tok/turn); ` +
        `identical content still on disk${keep.length ? ` at ${keep[0].p.replace(/[^/]+$/, '')}` : ` under ${canon[0]}`} — Read on demand, nothing was lost`,
    );
  }
  if (!out.length) return null;
  const msg = `[context-budget] ${out.join(' | ')}`;
  return msg.length > MAX_OUT ? `${msg.slice(0, MAX_OUT - 1)}…` : msg;
}
