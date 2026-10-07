#!/usr/bin/env node
// Mechanical correctness check for a project's documentation — agent-facing AND human-facing.
// Zero model tokens: everything here is decidable from paths, sizes, mtimes and a local read.
// Run at the end of any docs pass (skills docs-triage / doc-hygiene / human-docs), and any time
// you want to know whether the layout still holds.
//
//   node <kit>/tools/docs-validate.mjs [dir] [--json] [--quiet]
//
// Exit 1 when a HARD violation exists (layout, naming, secrets, dead links), 0 otherwise —
// so it can gate a pass. Warnings never fail the run.
//
// Every finding is an instruction some docs skill will follow (move, archive, rotate), so a false
// one breaks things. Calibrated on 5 real repos 23.09.2026.
// The user's per-project policy (doc-policy-set) binds here too: `off` = placement and language
// advice suppressed, secrets/size/links still reported; `extraRoots` = legal agent-doc homes.
import { readdirSync, statSync, readFileSync, existsSync } from 'node:fs';
import { join, resolve, sep, relative, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import {
  BUDGET,
  TTL_D,
  projectRoot,
  policyFor,
  FIXED_AGENT_NAMES,
  DURABLE_DOC_NAMES,
} from '../hooks/lib/doc-policy.mjs';
import { isAgentDoc, cyrillicShare } from '../hooks/lib/agent-doc.mjs';

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith('--')));
const target = resolve(args.find((a) => !a.startsWith('--')) ?? process.cwd());
const ROOT = projectRoot(target) ?? target;
const norm = (p) => resolve(p).split(sep).join('/');
const rel = (p) => relative(ROOT, p).split(sep).join('/');

// A CLI's home config dir (~/.claude, ~/.codex, ~/.qwen …) is its configuration tree, not a project: it holds hundreds of third-party
// plugin and transcript files this validator has no authority over. Scanning it produces hundreds
// of meaningless violations and would train the reader to ignore the output.
const CLI_HOMES = ['.claude', '.codex', '.qwen', '.gemini', '.kimi', '.cursor'];
if (CLI_HOMES.some((d) => norm(ROOT).toLowerCase() === norm(join(homedir(), d)).toLowerCase())) {
  console.log(
    'docs-validate: this is a CLI config tree, not a project — nothing to validate here.',
  );
  console.log('To check a project, run the tool inside it, or pass its path.');
  process.exit(0);
}

const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'out',
  'coverage',
  '.next',
  'vendor',
  '.venv',
]);
// Root files that convention (and GitHub) requires to stay at the root, unrenamed.
const ROOT_HUMAN =
  /^(README(\.[a-z-]+)?|CHANGELOG|CONTRIBUTING|LICENSE|SECURITY|CODE_OF_CONDUCT|TASKS)(\.md)?$/i;
const EXEMPT_AGENT_DIRS = /^\.agent\/(tmp|archive|backup|screenshots|\.trash)\//i;
// Not documentation at all — only the secret scan applies: tool dot-dirs (.github templates,
// .changeset, .expo…; .agent/.claude are ours and fully checked), test data, and .txt, which in a
// source tree is CMakeLists / requirements / fixtures far more often than prose (inside .agent/ it
// is an agent artifact — generated outlines, logs — and keeps every check).
const DATA_ZONE =
  /(^|\/)(\.(?!agent\/|claude\/)[^/]+|__fixtures__|__snapshots__|fixtures|testdata)\//i;
// A README beside a package manifest is the package's own page (npm, Go, crates render it there).
const MANIFESTS = [
  'package.json',
  'go.mod',
  'pyproject.toml',
  'Cargo.toml',
  'composer.json',
  'pom.xml',
  'build.gradle',
  'build.gradle.kts',
];
const POLICY = policyFor(ROOT);
const HANDS_OFF = POLICY.mode === 'off';
const EXTRA_ROOTS = POLICY.extraRoots.map((r) => r.replace(/\\/g, '/').replace(/\/+$/, '') + '/');
// Both name lists come from doc-policy — local copies here drifted from the guards' copies and the
// validator ended up flagging .agent/glossary.md while CLAUDE.md mandated it.
const FIXED_AGENT = FIXED_AGENT_NAMES;
const DURABLE = DURABLE_DOC_NAMES;

// Deliberately narrow: a false "secret found" that turns out to be an example wastes more time
// than it saves. These patterns do not fire on placeholders.
const SECRETS = [
  [/\bAKIA(?!IOSFODNN7EXAMPLE)[0-9A-Z]{16}\b/, 'AWS access key id'], // AWS's own documentation key
  [/\bgh[pousr]_[A-Za-z0-9]{36,}\b/, 'GitHub token'],
  [/\bsk-[A-Za-z0-9]{32,}\b/, 'API secret key'],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/, 'Slack token'],
  [/-----BEGIN (RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/, 'private key'],
  // A value, not code: a digit or a hyphen in it (identifiers carry neither), no call after it — `token: String`, `token = jwt.encode(` and
  // `secret = response.data.secret` were 25 of 26 hits on real repos.
  [
    /\b(password|passwd|pwd|secret|token)\s*[:=]\s*["']?(?!<|\{|\$|your|xxx|\.\.\.|example|changeme|fill)(?=[\w\-+/=.~]*[\d-])[\w\-+/=.~]{8,}(?![\w\-+/=.~(])/i,
    'literal credential',
  ],
];

const hard = [];
const warn = [];
const files = [];

function walk(dir, depth = 0) {
  if (depth > 12) return;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      walk(p, depth + 1);
      continue;
    }
    if (!/\.(md|markdown|txt|rst|adoc)$/i.test(e.name)) continue;
    try {
      const st = statSync(p);
      files.push({
        p: norm(p),
        r: rel(p),
        name: e.name,
        size: st.size,
        age: Math.round((Date.now() - st.mtimeMs) / 864e5),
      });
    } catch {
      /* unreadable — nothing to check */
    }
  }
}
walk(ROOT);

const bodyOf = (f) => {
  try {
    return readFileSync(f.p, 'utf8');
  } catch {
    return '';
  }
};

const seenHashes = new Map();

for (const f of files) {
  const r = f.r;
  const agent = isAgentDoc(f.p);
  const inAgentDir = /^\.agent\//i.test(r);
  const inClaudeDir = /^\.claude\//i.test(r);
  const inDocs = /^docs?\//i.test(r);
  const atRoot = !r.includes('/');
  const body = bodyOf(f);

  // 1. Secrets — the only check that matters regardless of audience.
  for (const [re, what] of SECRETS) {
    if (re.test(body)) {
      hard.push(`SECRET  ${r} — looks like ${what}; remove it from the document and rotate it`);
      break;
    }
  }

  // Dead storage (archive/ tmp/ .trash/ backup/) is never read by anyone: its language, size and
  // links cost nothing. Only secrets still matter there — everything else would be pure noise.
  // Markdown under src/ that is not a README is product data (prompt catalogs, content) the code
  // loads by path — moving it to docs/ breaks the product.
  const productData = /(^|\/)src\//i.test(r) && !/^README\.md$/i.test(f.name);
  if (
    EXEMPT_AGENT_DIRS.test(r) ||
    DATA_ZONE.test(r) ||
    (/\.txt$/i.test(f.name) && !/^\.agent\//i.test(r)) ||
    productData
  )
    continue;
  const inExtraRoot = EXTRA_ROOTS.some((x) => r.toLowerCase().startsWith(x.toLowerCase()));
  const placementAdvice = !HANDS_OFF && !inExtraRoot;

  // 2. Layout.
  if (
    placementAdvice &&
    agent &&
    !inAgentDir &&
    !inClaudeDir &&
    !/^(CLAUDE|CLAUDE\.local|AGENTS)\.md$/i.test(f.name)
  ) {
    hard.push(
      `LAYOUT  ${r} — agent doc outside .agent/; move it to .agent/${f.name.replace(/\.md$/i, '.agent.md')}`,
    );
  }
  const packagePage =
    /^README\.md$/i.test(f.name) && MANIFESTS.some((m) => existsSync(join(dirname(f.p), m)));
  if (
    placementAdvice &&
    !agent &&
    !inDocs &&
    !atRoot &&
    !inAgentDir &&
    !inClaudeDir &&
    !packagePage
  ) {
    warn.push(`LAYOUT  ${r} — human doc outside docs/ and not at the root; move it to docs/`);
  }
  if (
    placementAdvice &&
    atRoot &&
    !agent &&
    !ROOT_HUMAN.test(f.name.replace(/\.(md|markdown|txt|rst|adoc)$/i, '')) &&
    !ROOT_HUMAN.test(f.name)
  ) {
    warn.push(
      `LAYOUT  ${r} — the root keeps only README/CHANGELOG/CONTRIBUTING/LICENSE/SECURITY/TASKS; the rest goes to docs/`,
    );
  }

  // 3. Naming: agent docs are suffixed, human docs never are.
  if (
    placementAdvice &&
    inAgentDir &&
    /\.md$/i.test(f.name) &&
    !EXEMPT_AGENT_DIRS.test(r) &&
    !FIXED_AGENT.test(f.name) &&
    !/\.agent\.md$/i.test(f.name)
  ) {
    hard.push(`NAMING  ${r} — inside .agent/ the name must be <slug>.agent.md`);
  }
  if (placementAdvice && !inAgentDir && !inClaudeDir && /\.agent\.md$/i.test(f.name)) {
    hard.push(`NAMING  ${r} — .agent.md suffix outside .agent/: move it there or drop the suffix`);
  }

  // 4. Language.
  if (!HANDS_OFF && agent && !body.includes('<!-- lang:ru -->')) {
    const { total, share } = cyrillicShare(body);
    if (total > 100 && share > 0.3)
      hard.push(
        `LANG    ${r} — agent doc not in English (${Math.round(share * 100)}% Cyrillic); rewrite it in English`,
      );
  }
  if (!HANDS_OFF && !agent && inDocs) {
    // Human docs default to Russian. A deliberate second language announces itself: an `.en.md`
    // name, or a Russian sibling next to it (README.md ↔ README.ru.md). Neither → probably a
    // misfiled agent doc.
    const base = f.name.replace(/\.(ru|en)\.md$/i, '').replace(/\.md$/i, '');
    const bilingual =
      /\.(ru|en)\.md$/i.test(f.name) || existsSync(join(dirname(f.p), `${base}.ru.md`));
    const { total, share } = cyrillicShare(body);
    if (total > 300 && share < 0.05 && !bilingual)
      warn.push(
        `LANG    ${r} — human doc not in the human language and without a translated twin; check whether it is an agent doc`,
      );
  }

  // 5. Size. Agent docs are billed per session, human docs are not — see BUDGET.humanWarn.
  const cap = agent ? BUDGET.ceiling : BUDGET.humanWarn;
  if (f.size > cap) {
    const kb = Math.round(f.size / 1024);
    (f.size > (agent ? BUDGET.dedicated : BUDGET.humanHard) ? hard : warn).push(
      `SIZE    ${r} — ${kb} KB (limit ${Math.round(cap / 1024)} KB); split by topic or move closed parts to the archive`,
    );
  }

  // 6. Emptiness — a stub is a promise nobody kept. A file whose whole body is an `@`-import is
  // the opposite: it is a BRIDGE, and a deliberate one since CC 2.1.277 made the name a choice —
  // `CLAUDE.md` holding only `@AGENTS.md` is how a repo keeps one source of truth while the CLI
  // still finds its entry. Calling it a stub told the user to delete the link, not the filler.
  const meat = body.replace(/^---[\s\S]*?---/, '').replace(/[#*_`>\-\s]/g, '');
  const isBridge = /^@[\w./-]+$/.test(body.replace(/^---[\s\S]*?---/, '').trim());
  if (meat.length < 80 && !isBridge) warn.push(`EMPTY   ${r} — empty or a stub; delete it`);

  // 7. Staleness — the .agent/ lifecycle only. CLAUDE.md and .claude/ rules/skills are committed
  // config: a checkout resets their mtime and a settled rule is untouched by design.
  if (!HANDS_OFF && agent && inAgentDir && !DURABLE.test(f.name) && f.age > TTL_D.stale) {
    warn.push(
      `STALE   ${r} — untouched for ${f.age}d (threshold ${TTL_D.stale}); check it and retire it to archive/`,
    );
  }

  // 8. Duplicates — exact and whitespace-insensitive.
  const key = createHash('sha1')
    .update(body.replace(/\s+/g, ' ').trim().toLowerCase())
    .digest('hex');
  if (meat.length >= 80) {
    if (seenHashes.has(key))
      hard.push(`DUPE    ${r} — identical to ${seenHashes.get(key)}; keep one`);
    else seenHashes.set(key, r);
  }

  // 9. Dead links: relative markdown targets that do not exist.
  for (const m of body.matchAll(/\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
    const href = m[1];
    if (/^(https?:|mailto:|#|<)/i.test(href)) continue;
    const clean = href.split('#')[0];
    if (!clean) continue;
    const abs = clean.startsWith('/') ? join(ROOT, clean) : join(dirname(f.p), clean);
    if (!existsSync(abs)) hard.push(`LINK    ${r} → ${href} — target missing`);
  }
}

// 10. Entry points.
if (!existsSync(join(ROOT, 'README.md')))
  warn.push('ENTRY   no README.md at the root — the human entry point is missing');
// Either name is a legitimate entry: CC 2.1.277 reads AGENTS.md in a root without CLAUDE.md
// (`instructionFiles`, default `claude-md-or-agents-md`), and every other CLI reads it already.
// Demanding CLAUDE.md fired a permanent false ENTRY on the first repo that moved — see
// `instructionChoice()` in hooks/lib/doc-policy.mjs, which records WHICH name a project chose.
const AGENT_ENTRY_NAMES = ['CLAUDE.md', 'AGENTS.md'];
if (
  files.some((f) => /^\.agent\//i.test(f.r)) &&
  !AGENT_ENTRY_NAMES.some((name) => existsSync(join(ROOT, name)))
)
  warn.push(
    'ENTRY   .agent/ exists but no CLAUDE.md / AGENTS.md at the root — an agent will not find the entry',
  );

if (flags.has('--json')) {
  console.log(
    JSON.stringify({ root: ROOT, policy: POLICY.mode, files: files.length, hard, warn }, null, 2),
  );
} else if (!flags.has('--quiet')) {
  console.log(`docs-validate: ${ROOT}\nfiles checked: ${files.length}\n`);
  if (HANDS_OFF)
    console.log(
      'project policy: off (hands off) — no advice on layout, names, staleness or language\n',
    );
  if (hard.length)
    console.log(`VIOLATIONS (${hard.length}):\n` + hard.map((s) => '  ' + s).join('\n') + '\n');
  if (warn.length)
    console.log(`WARNINGS (${warn.length}):\n` + warn.map((s) => '  ' + s).join('\n') + '\n');
  if (!hard.length && !warn.length)
    console.log('clean: layout, names, language, sizes, links, duplicates — nothing to report');
}
process.exit(hard.length ? 1 : 0);
