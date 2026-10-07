// DAILY review of agent docs (PostToolUse on Write|Edit).
// Mechanical part (metadata inventory) here; the semantic part (compress / archive / delete)
// goes to the model. Trigger: FIRST agent-doc write of the day → near-free.
// Files are never read into context; only size/mtime + a local Cyrillic probe.
// Kill-switch: AGENTDECK_KIT_DOC_REVIEW=0 (CLAUDE_DOC_REVIEW=0 honoured).
import { readdirSync, statSync, existsSync, writeFileSync, readFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import { isAgentDoc } from './agent-doc.mjs';
import { BUDGET, TTL_D, hygieneDisabled, DURABLE_DOC_NAMES } from './doc-policy.mjs';

const DAY = 864e5;
const STALE_D = TTL_D.stale; // one dead threshold for everything the agent reads

export default function docDailyReview(input) {
  const filePath = String(input?.tool_input?.file_path ?? '');
  if (!filePath || !isAgentDoc(filePath)) return null;
  if (hygieneDisabled(filePath)) return null; // user said hands off this project
  return reviewInventory();
}

// Same body, no write to trigger it: SessionStart calls this so the revision happens once a day
// even in a session that never edits an agent doc. The `.last-review` stamp is shared, so
// whichever entry point fires first spends the day's budget — never both.
export function reviewInventory() {
  if (process.env.AGENTDECK_KIT_DOC_REVIEW === '0' || process.env.CLAUDE_DOC_REVIEW === '0')
    return null;
  if (hygieneDisabled(process.cwd())) return null;

  const NOW = Date.now();
  const roots = [];
  try {
    const cwd = process.cwd();
    if (existsSync(join(cwd, '.agent'))) roots.push(join(cwd, '.agent'));
    for (const e of readdirSync(cwd, { withFileTypes: true })) {
      if (e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules') {
        const d = join(cwd, e.name, '.agent');
        if (existsSync(d)) roots.push(d);
      }
    }
    const memDir = join(
      process.env.USERPROFILE || process.env.HOME || '',
      '.claude',
      'projects',
      cwd.replace(/:/g, '-').replace(/[\\/]/g, '-'),
      'memory',
    );
    if (existsSync(memDir)) roots.push(memDir);
  } catch {
    return null;
  }
  if (!roots.length) return null;

  // Once per day.
  const stamp = join(roots[0], '.last-review');
  try {
    if (existsSync(stamp) && NOW - statSync(stamp).mtimeMs < DAY) return null;
  } catch {
    /* no stamp — first review */
  }

  const docs = [];
  const stale = []; // untouched long enough to be presumed dead
  const ru = []; // agent docs still written in Cyrillic
  let tmpCount = 0;
  let oldShots = 0;

  // The hook reads files ITSELF — costs zero model tokens, so language detection happens here
  // and the model only gets a compact verdict.
  function cyrillicHeavy(file) {
    try {
      const head = readFileSync(file, 'utf8').slice(0, 4000);
      if (!head) return false;
      // Same escape hatch language-guard honours: a marked file is deliberately non-English.
      // Without this the review nags every day about a file the user already ruled on.
      if (/<!-- lang:[a-z-]+ -->/.test(head)) return false;
      return (head.match(/[\u0400-\u04FF]/g) || []).length / head.length > 0.08;
    } catch {
      return false;
    }
  }

  function walk(dir, depth) {
    if (depth > 5) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name === '.trash' || e.name === 'archive') continue;
      const f = join(dir, e.name);
      if (e.isDirectory()) {
        if (f.split(sep).join('/').includes('/.agent/tmp')) {
          try {
            tmpCount += readdirSync(f).length;
          } catch {
            /* skip */
          }
          continue;
        }
        if (/before-after$/.test(dir)) {
          try {
            if (NOW - statSync(f).mtimeMs > TTL_D.screenshots * DAY) oldShots += 1;
          } catch {
            /* skip */
          }
        }
        walk(f, depth + 1);
        continue;
      }
      if (!/\.md$/i.test(e.name)) continue;
      try {
        const sz = statSync(f).size;
        const age = Math.round((NOW - statSync(f).mtimeMs) / DAY);
        // Review threshold = "must act" (15 KB), not "smells" (8 KB): small overruns are caught
        // by doc-bloat-guard at write time; only real problems belong in this list.
        if (sz > BUDGET.ceiling) docs.push({ n: e.name, kb: Math.round(sz / 1024), age });
        // Dead weight is the bigger win: retiring a stale file costs nothing to decide (metadata
        // only) and removes it from every future context. Durable docs never go stale by age.
        const durable = DURABLE_DOC_NAMES.test(e.name);
        if (!durable && age > STALE_D) stale.push({ n: e.name, kb: Math.round(sz / 1024), age });
        // DATA files (audits, measurements, figma refs) are pointless to translate: tables of
        // numbers/node-ids/hex, not prose.
        const isData = /[\\/](audit|figma-refs|sheet)[\\/]/.test(f);
        if (!isData && cyrillicHeavy(f)) ru.push({ n: e.name, kb: Math.round(sz / 1024) });
      } catch {
        /* skip */
      }
    }
  }
  for (const r of roots) walk(r, 0);

  try {
    writeFileSync(stamp, new Date(NOW).toISOString());
  } catch {
    /* not critical */
  }

  docs.sort((a, b) => b.kb - a.kb);
  ru.sort((a, b) => b.kb - a.kb);
  stale.sort((a, b) => b.age - a.age);
  if (!docs.length && !ru.length && !stale.length && !tmpCount && !oldShots) return null;

  // The action ladder itself lives in skill doc-hygiene (Mode A) — repeating it here spent ~900
  // chars of context every time the review fired, for a procedure that never changes. The hook
  // ships only what the skill cannot know: today's file list.
  const fmt = (list, n) =>
    list
      .slice(0, n)
      .map((d) => `${d.n} ${d.kb}KB${d.age != null ? `/${d.age}d` : ''}`)
      .join(', ');
  const parts = [];
  if (docs.length) parts.push(`>15KB: ${fmt(docs, 5)}`);
  if (stale.length) parts.push(`dead? (>${STALE_D}d): ${fmt(stale, 5)}`);
  if (ru.length) parts.push(`RU (${ru.length}): ${fmt(ru, 3)}`);
  if (tmpCount) parts.push(`tmp: ${tmpCount}`);
  if (oldShots) parts.push(`old shot dirs: ${oldShots}`);

  return `[doc-daily-review] ${parts.join(' | ')} → one pass now per skill doc-hygiene Mode A (archive dead → compress → translate 1-2), report 1 line RU.`;
}
