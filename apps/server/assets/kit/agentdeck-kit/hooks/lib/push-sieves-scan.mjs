// Content sieves of a publish (called by push-sieves.mjs after the conflict and foreign-removal
// checks): what the branch ADDS, read by git alone over `<merge-base with fresh main>..<branch>`.
// Ported from agentdeck's `project-git/sieve-scan.ts` + `sieve-facts-scan.ts` + `sieve-facts.ts`
// `consumersOf` (the panel's sieves work outside the panel too), not imported — hooks are
// plain node with no build step. The panel keeps its own copy; a change to one owes the other.
//
// Tuned for PRECISION, not reach (same rule as the panel): a false deny teaches the agent to ack
// without reading. So a secret is only a vendor-shaped key, debug is only what is unambiguously
// debug, an env var only without a default on the same line. Blocking ones clear by naming every
// flagged file or name on a `# sieve-ack:` line; heuristic ones (code without a test, destructive
// migration, high-risk paths) are notes in context, never a deny.
//
// Everything reads the BRANCH ref, not the work tree: `git push origin feat` from another checkout
// publishes `feat`, whatever is on disk.
import path from 'node:path';

const TOKENS_MAX = 40;
const FILES_PER_TOKEN = 5;
const ENV_NAMES_MAX = 20;
const ADDED_FILES_MAX = 200;
export const LARGE_FILE_BYTES = 5 * 1024 * 1024;

// --- path kinds (contracts/sieves/catalog.ts) ------------------------------------------------------
const UI_EXT = /\.(tsx|jsx|vue|svelte|astro|css|scss|sass|less|html)$/i;
const BACKEND_EXT = /\.(go|py|java|kt|kts|rb|php|rs|cs|ex|exs|scala|sql)$/i;
const CODE_EXT = /\.(m?[jt]sx?|c[jt]s)$/i;
const TEST_PATH =
  /(^|\/)(__tests__|tests?|e2e|qa|spec|cypress|playwright)\/|\.(test|spec|stories)\.[^/]+$/i;
const DOT_DIR = /(^|\/)\.[^/]+\//;
const DATA_PATH =
  /(^|\/)(migrations?|migrate|alembic|flyway|liquibase)\/|(^|\/)db\/(changelog\/|(schema|structure)\.)|\.sql$|(^|\/)schema\.prisma$|(^|\/)[^/]*migration[^/]*\.(sql|py|rb|go|java|kt|m?[jt]s|c[jt]s|php|cs|exs?|ya?ml|xml|json)$/i;
const SENSITIVE_PATH =
  /(^|[/_.-])(auth\w*|login|logout|oauth|sso|saml|passw\w*|credential\w*|secrets?|crypt\w*|permission\w*|rbac|acl|polic(y|ies)|payments?|billing|invoices?|checkout|wallets?|security)([/_.-]|$)/i;
const LARGE_DIFF_FILES = 40;

const slash = (p) => String(p).replace(/\\/g, '/');
export const isTestPath = (p) => TEST_PATH.test(slash(p));
export function isProductCode(p) {
  const s = slash(p);
  return (
    !DOT_DIR.test(s) &&
    !TEST_PATH.test(s) &&
    (UI_EXT.test(s) || BACKEND_EXT.test(s) || CODE_EXT.test(s))
  );
}
const isData = (p) => !TEST_PATH.test(slash(p)) && DATA_PATH.test(slash(p));

/** High risk and why — data, sensitive paths, a large diff (`riskTier`). */
export function riskReasons(paths) {
  const product = paths.map(slash).filter((p) => !DOT_DIR.test(p) && !TEST_PATH.test(p));
  const reasons = [];
  if (product.some(isData)) reasons.push('data/migration');
  const sensitive = product.find((p) => SENSITIVE_PATH.test(p));
  if (sensitive) reasons.push(`sensitive path ${sensitive}`);
  const code = product.filter(isProductCode).length;
  if (code >= LARGE_DIFF_FILES) reasons.push(`${code} code files`);
  return reasons;
}

// --- diff ---------------------------------------------------------------------------------------------
/**
 * `git diff -U0` → removed hunks (with their lines) and additions `{path, text}`. Inside a hunk the
 * old/new counts decide what a line is: an added line `++ x` reads `+++ x` and is NOT a file header.
 */
export function parseDiff(diff) {
  const removed = [];
  const additions = [];
  let file;
  let target;
  let hunk;
  let oldLeft = 0;
  let newLeft = 0;
  for (const line of String(diff).split('\n')) {
    if (oldLeft > 0 || newLeft > 0) {
      if (line.startsWith('-') && oldLeft > 0) {
        oldLeft--;
        hunk?.lines.push(line.slice(1));
        continue;
      }
      if (line.startsWith('+') && newLeft > 0) {
        newLeft--;
        if (target) additions.push({ path: target, text: line.slice(1) });
        continue;
      }
      if (line.startsWith('\\')) continue;
      oldLeft = newLeft = 0;
    }
    if (line.startsWith('--- ')) {
      const name = line.slice(4).trim();
      file = name === '/dev/null' ? undefined : name.replace(/^a\//, '');
      hunk = undefined;
      continue;
    }
    if (line.startsWith('+++ ')) {
      const name = line.slice(4).trim();
      target = name === '/dev/null' ? undefined : name.replace(/^b\//, '');
      continue;
    }
    const head = /^@@ -(\d+)(?:,(\d+))? \+\d+(?:,(\d+))? @@/.exec(line);
    if (head) {
      const count = head[2] === undefined ? 1 : Number(head[2]);
      oldLeft = count;
      newLeft = head[3] === undefined ? 1 : Number(head[3]);
      hunk = file && count > 0 ? { path: file, lines: [] } : undefined;
      if (hunk) removed.push(hunk);
    }
  }
  return { removed, additions };
}

// --- secrets ------------------------------------------------------------------------------------------
const SECRET_KEY = new RegExp(
  [
    String.raw`sk-[A-Za-z0-9_-]{16,}`,
    String.raw`[sr]k_(?:live|test)_[0-9A-Za-z]{16,}`,
    String.raw`gh[pousr]_[A-Za-z0-9]{20,}`,
    String.raw`github_pat_[A-Za-z0-9_]{22,}`,
    String.raw`gl(?:pat|dt|rt|ptt|cbt)-[A-Za-z0-9_-]{20,}`,
    String.raw`(?:AKIA|ASIA)[0-9A-Z]{16}`,
    String.raw`AIza[0-9A-Za-z_-]{35}`,
    String.raw`ya29\.[0-9A-Za-z_-]{20,}`,
    String.raw`xox[baprse]-[A-Za-z0-9-]{10,}`,
    String.raw`xapp-\d-[A-Za-z0-9-]{10,}`,
    String.raw`https://hooks\.slack\.com/services/[A-Za-z0-9/_-]{20,}`,
    String.raw`npm_[A-Za-z0-9]{36}`,
    String.raw`hf_[A-Za-z0-9]{30,}`,
    String.raw`SG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}`,
    String.raw`(?<!\d)\d{8,10}:AA[A-Za-z0-9_-]{33}`,
    String.raw`figd_[A-Za-z0-9_-]{20,}`,
  ].join('|'),
);
const JWT = /\beyJ[A-Za-z0-9_-]{5,}\.eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{10,}/;
const PRIVATE_KEY = /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----/;
// Password inside a URL. Local hosts are skipped (a deviation from the panel): `postgres://u:p@localhost`
// sits in half the READMEs and docker-composes, and a deny there would be acked on reflex.
const CREDENTIALS_URL = /\b[a-z][a-z0-9+.-]{1,20}:\/\/[^\s:/@]{1,64}:[^\s:/@]{3,}@([^\s/:?#]+)/i;
const LOCAL_HOST =
  /^(localhost|127\.0\.0\.1|0\.0\.0\.0|db|postgres|mysql|redis|example\.(com|org)|host)$/i;
const PLACEHOLDER = /(xxx|your[-_]|<[^>]+>|example|placeholder|changeme|\*\*\*|dummy)/i;
const LOCK_FILE =
  /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|poetry\.lock|uv\.lock|pdm\.lock|go\.sum|Cargo\.lock|Gemfile\.lock|composer\.lock)$/;

const uniq = (xs) => [...new Set(xs)].sort();

function secretIn(text) {
  for (const re of [SECRET_KEY, JWT, PRIVATE_KEY]) {
    const m = text.match(re);
    if (m && !PLACEHOLDER.test(m[0])) return true;
  }
  const url = text.match(CREDENTIALS_URL);
  return Boolean(url && !LOCAL_HOST.test(url[1]) && !PLACEHOLDER.test(url[0]));
}

/** Files whose added lines carry a secret (lock files excluded: integrity hashes look like keys). */
export const secretsIn = (additions) =>
  uniq(additions.filter((a) => !LOCK_FILE.test(a.path) && secretIn(a.text)).map((a) => a.path));

// --- debug leftovers ----------------------------------------------------------------------------------
const CONFLICT_MARKER = /^(<{7}|>{7})( |$)|^={7}$/;
const FOCUSED_TEST = /\b(?:describe|it|test|context|suite)\.only\s*\(|\b(?:fdescribe|fit)\s*\(/;
const DEBUG_STATEMENT =
  /^\s*debugger\s*;?\s*$|^\s*(?:breakpoint\(\)|import\s+i?pdb\b|i?pdb\.set_trace\(\))|\bbinding\.pry\b/;

/** Conflict markers anywhere, a focused test in tests, `debugger`/`breakpoint()` in product code. */
export const debugLeftoversIn = (additions) =>
  uniq(
    additions
      .filter((a) => {
        if (CONFLICT_MARKER.test(a.text)) return !/\.(md|mdx|rst|adoc|txt)$/i.test(a.path);
        if (isTestPath(a.path)) return FOCUSED_TEST.test(a.text);
        return isProductCode(a.path) && DEBUG_STATEMENT.test(a.text);
      })
      .map((a) => a.path),
  );

// --- lockfiles ----------------------------------------------------------------------------------------
const MANIFESTS = [
  {
    name: 'package.json',
    locks: [
      'package-lock.json',
      'npm-shrinkwrap.json',
      'pnpm-lock.yaml',
      'yarn.lock',
      'bun.lockb',
      'bun.lock',
    ],
    dependency:
      /^\s*"(?:@[\w.-]+\/)?[\w.-]+"\s*:\s*"(?:[~^<>=*]|\d|workspace:|npm:|file:|link:|git|https?:|latest)/,
  },
  {
    name: 'pyproject.toml',
    locks: ['poetry.lock', 'uv.lock', 'pdm.lock'],
    dependency: /(?:==|>=|<=|~=|!=|\^\d|["'][\w.-]+\s*[<>=~!]|^\s*[\w.-]+\s*=\s*["'{])/,
  },
  { name: 'go.mod', locks: ['go.sum'], dependency: /^\s*(?:require\s+)?[\w./-]+\s+v\d/ },
  { name: 'Cargo.toml', locks: ['Cargo.lock'], dependency: /^\s*[\w-]+\s*=\s*["{]/ },
  { name: 'Gemfile', locks: ['Gemfile.lock'], dependency: /^\s*gem\s+["']/ },
  { name: 'composer.json', locks: ['composer.lock'], dependency: /^\s*"[\w.-]+\/[\w.-]+"\s*:\s*"/ },
];

/** Manifests whose dependency line changed while a lock the repo keeps (beside it or at root) did not. */
export function lockfileGapsIn({ changed, lines, tracked }) {
  const ch = new Set(changed);
  const tr = new Set(tracked);
  const gaps = [];
  for (const p of changed) {
    const m = MANIFESTS.find((x) => path.posix.basename(p) === x.name);
    if (!m || !lines.some((l) => l.path === p && m.dependency.test(l.text))) continue;
    const dir = path.posix.dirname(p);
    const candidates = m.locks.flatMap((lock) =>
      [dir === '.' ? lock : `${dir}/${lock}`, lock].filter((f) => tr.has(f)),
    );
    if (candidates.length && !candidates.some((f) => ch.has(f))) gaps.push(p);
  }
  return uniq(gaps);
}

// --- env vars -----------------------------------------------------------------------------------------
const ENV_READS = [
  /process\.env\.([A-Z][A-Z0-9_]{2,})/g,
  /process\.env\[\s*['"`]([A-Z][A-Z0-9_]{2,})['"`]\s*\]/g,
  /import\.meta\.env\.([A-Z][A-Z0-9_]{2,})/g,
  /os\.(?:environ\.get|getenv)\(\s*['"]([A-Z][A-Z0-9_]{2,})['"]/g,
  /os\.environ\[\s*['"]([A-Z][A-Z0-9_]{2,})['"]\s*\]/g,
  /os\.(?:Getenv|LookupEnv)\(\s*"([A-Z][A-Z0-9_]{2,})"/g,
  /env::var(?:_os)?\(\s*"([A-Z][A-Z0-9_]{2,})"/g,
  /ENV(?:\.fetch\(|\[)\s*['"]([A-Z][A-Z0-9_]{2,})['"]/g,
  /System\.getenv\(\s*"([A-Z][A-Z0-9_]{2,})"/g,
  /Environment\.GetEnvironmentVariable\(\s*"([A-Z][A-Z0-9_]{2,})"/g,
  /\bgetenv\(\s*['"]([A-Z][A-Z0-9_]{2,})['"]/g,
  /\$_ENV\[\s*['"]([A-Z][A-Z0-9_]{2,})['"]\s*\]/g,
];
const AMBIENT = new Set(
  'NODE_ENV HOME PATH PWD USER USERNAME SHELL TERM LANG TMPDIR TEMP TMP APPDATA LOCALAPPDATA USERPROFILE HOSTNAME CI GITHUB_ACTIONS GITLAB_CI PORT DEBUG TZ'.split(
    ' ',
  ),
);
const HAS_DEFAULT = /^\s*(?:\?\?|\|\||,|\)\s*\.(?:unwrap_or|or_else|get_or)|\)\s*or\b)/;
const LOCAL_ENV = /(^|\/)\.env(\.[\w-]+)?$/i;
const EXAMPLE_ENV = /\.(example|sample|template|dist|defaults?)$/i;

/** Env vars product code starts reading in added lines with no default on the same line. */
export function envReadsIn(additions) {
  const names = new Set();
  for (const a of additions) {
    if (!isProductCode(a.path)) continue;
    for (const re of ENV_READS) {
      for (const m of a.text.matchAll(re)) {
        if (AMBIENT.has(m[1])) continue;
        if (!HAS_DEFAULT.test(a.text.slice(m.index + m[0].length))) names.add(m[1]);
      }
    }
  }
  return [...names].sort();
}

/** A file that counts as declaring an env var: config, sample env, deploy manifest, docs — not a local .env. */
export const declaresEnv = (p) =>
  LOCAL_ENV.test(p) && !EXAMPLE_ENV.test(p) ? false : !isProductCode(p) && !isTestPath(p);

// --- committed artifacts ------------------------------------------------------------------------------
const LOCAL_FILE =
  /(^|\/)\.env(\.[\w-]+)?$|\.(pem|key|p12|pfx|jks|keystore)$|(^|\/)id_(rsa|dsa|ecdsa|ed25519)$/i;

/** Added files that do not belong in git: .env and keys by name, force-added ignored, over 5 MB. */
export function artifactsIn({ added, ignored, sizes }) {
  const ig = new Set(ignored);
  return uniq(
    added.filter(
      (p) =>
        (LOCAL_FILE.test(p) && !EXAMPLE_ENV.test(p)) ||
        ig.has(p) ||
        (sizes[p] ?? 0) > LARGE_FILE_BYTES,
    ),
  );
}

// --- consumers of removed names -----------------------------------------------------------------------
const DECLARATION =
  /\bexport\s+(?:default\s+)?(?:declare\s+)?(?:async\s+)?(?:function\*?|const|let|var|class|interface|type|enum)\s+([A-Za-z_$][\w$]{3,})/g;
const TEST_ID =
  /\b(?:data-testid|data-test-id|data-qa|testID)\s*=\s*\{?\s*["'`]([\w:.-]{3,})["'`]/g;
const esc = (v) => v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Exported names and test ids the branch removed and did not re-add anywhere. */
export function removedTokens({ removed, additions }) {
  const addedText = additions.map((a) => a.text).join('\n');
  const tokens = new Map();
  for (const h of removed) {
    for (const line of h.lines) {
      for (const m of line.matchAll(DECLARATION)) tokens.set(m[1], 'name');
      for (const m of line.matchAll(TEST_ID)) tokens.set(m[1], 'testid');
    }
  }
  return [...tokens]
    .filter(([t]) => !new RegExp(`(^|[^\\w$])${esc(t)}([^\\w$]|$)`).test(addedText))
    .map(([token, kind]) => ({ token, kind }));
}

// --- git-fed scan -------------------------------------------------------------------------------------
const nul = (out) =>
  String(out)
    .split('\0')
    .map((s) => s.trim())
    .filter(Boolean);

/** `git grep -l` over the branch tree → repo paths (the `<ref>:` prefix stripped). */
function grepFiles(git, cwd, ref, args) {
  const r = git(cwd, ['grep', '-l', ...args, ref, '--']);
  if (r.code !== 0) return r.code === -2 ? null : [];
  return r.stdout
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => (l.startsWith(`${ref}:`) ? l.slice(ref.length + 1) : l));
}

/**
 * Every content sieve over `base..ref` → `{ blocks, advisories, notes }`. A block is
 * `{ id, items, why }` — items are what the ack line must name; an advisory is a context line.
 * `git` is push-sieves' bounded runner: code -2 = time budget spent → the rest is a note.
 */
export function scanBranch(git, { cwd, base, ref }) {
  const out = { blocks: [], advisories: [], notes: [] };
  const names = git(cwd, ['diff', '--name-only', '-z', '--no-renames', base, ref]);
  if (names.code !== 0) return (out.notes.push('content sieves not run (diff failed)'), out);
  const paths = nul(names.stdout).filter((p) => !DOT_DIR.test(p));
  if (!paths.length) return out;
  const diff = parseDiff(
    git(cwd, ['diff', '-U0', '--no-color', '--no-ext-diff', '--no-renames', base, ref]).stdout,
  );
  const additions = diff.additions.filter((a) => !DOT_DIR.test(a.path));
  const removedLines = diff.removed.flatMap((h) => h.lines.map((text) => ({ path: h.path, text })));
  const block = (id, items, why) => items.length && out.blocks.push({ id, items, why });

  block(
    'secrets',
    secretsIn(additions),
    'a vendor-shaped key, JWT, private key or password-in-URL in added lines — a real one is removed AND rotated (deleting it from the branch does not un-leak it); a fake fixture is named with why it is fake',
  );
  block(
    'debug-leftovers',
    debugLeftoversIn(additions),
    'a focused test (.only/fit/fdescribe — silently skips the rest of the suite in CI), debugger/breakpoint()/pdb or a merge-conflict marker',
  );

  const added = nul(git(cwd, ['diff', '--name-only', '-z', '--diff-filter=A', base, ref]).stdout)
    .filter((p) => !DOT_DIR.test(p))
    .slice(0, ADDED_FILES_MAX);
  if (added.length) {
    const ignored = git(cwd, ['check-ignore', '--no-index', '-z', '--', ...added]);
    const sizes = {};
    for (const e of nul(git(cwd, ['ls-tree', '-r', '-l', '-z', ref, '--', ...added]).stdout)) {
      const m = /^\d+ blob [0-9a-f]+\s+(\d+)\t(.+)$/.exec(e);
      if (m) sizes[m[2]] = Number(m[1]);
    }
    block(
      'committed-artifacts',
      artifactsIn({ added, ignored: ignored.code === 0 ? nul(ignored.stdout) : [], sizes }),
      'a .env file, a key file, a file .gitignore excludes (force-added) or a file over 5 MB',
    );
  }

  const tracked = nul(git(cwd, ['ls-tree', '-r', '--name-only', '-z', ref]).stdout);
  block(
    'lockfile-sync',
    lockfileGapsIn({ changed: paths, lines: [...additions, ...removedLines], tracked }),
    "a dependency manifest changed while its lockfile did not — regenerate it with the project's own package manager",
  );

  const env = [];
  for (const name of envReadsIn(additions).slice(0, ENV_NAMES_MAX)) {
    const files = grepFiles(git, cwd, ref, ['-w', '-F', '-e', name]);
    if (files === null) {
      out.notes.push('time budget spent — env-config partly checked');
      break;
    }
    if (!files.some(declaresEnv)) env.push(name);
  }
  block(
    'env-config',
    env,
    'the code starts reading these env vars with no default, and no config/.env.example/compose/Helm/doc file declares them — the first deploy fails or runs on undefined',
  );

  const consumers = [];
  for (const { token, kind } of removedTokens({ removed: diff.removed, additions }).slice(
    0,
    TOKENS_MAX,
  )) {
    const files = grepFiles(git, cwd, ref, ['-w', '-F', '-e', token]);
    if (files === null) {
      out.notes.push('time budget spent — consumers partly checked');
      break;
    }
    if (!files.length) continue;
    if (kind === 'name') {
      const declared = grepFiles(git, cwd, ref, [
        '-E',
        '-e',
        `(function\\*?|const|let|var|class|interface|type|enum|def|func)[[:space:]]+${esc(token)}([^[:alnum:]_$]|$)`,
      ]);
      if (declared === null || declared.length) continue;
      consumers.push(`${token} (${files.slice(0, FILES_PER_TOKEN).join(', ')})`);
    } else if (!files.some((f) => !isTestPath(f)) && files.some(isTestPath)) {
      consumers.push(`${token} (${files.filter(isTestPath).slice(0, FILES_PER_TOKEN).join(', ')})`);
    }
  }
  if (consumers.length)
    out.blocks.push({
      id: 'consumers',
      items: consumers.map((c) => c.split(' ')[0]),
      shown: consumers,
      why: 'removed exported names / test ids are declared nowhere now but still referenced — a broken call or e2e outside the diff',
    });

  // Advisories — heuristics a deny would turn into reflex acks.
  const code = paths.filter(isProductCode);
  if (code.length && !paths.some(isTestPath))
    out.advisories.push(
      `tests-alongside: product code changed with no test file changed (${code.slice(0, 6).join(', ')}${code.length > 6 ? ', …' : ''}) — a behaviour change ships with a test that fails without it, or the MR says why none is needed`,
    );
  const DESTRUCTIVE =
    /\b(?:DROP\s+(?:TABLE|COLUMN|SCHEMA|DATABASE|VIEW)|TRUNCATE\b|ALTER\s+TABLE\s+\S+\s+(?:RENAME|DROP)|ALTER\s+COLUMN\s+\S+\s+(?:SET\s+DATA\s+)?TYPE|DELETE\s+FROM\s+[\w."`]+\s*;)|\b(?:drop_table|remove_column|rename_column|change_column|dropColumn|dropTable|renameColumn|op\.drop_(?:table|column)|op\.alter_column|DeleteModel|RemoveField|RenameField|AlterField)\b/i;
  const destructive = uniq(
    additions.filter((a) => isData(a.path) && DESTRUCTIVE.test(a.text)).map((a) => a.path),
  );
  if (destructive.length)
    out.advisories.push(
      `migration-safety: destructive statements in ${destructive.join(', ')} — expand → migrate → contract, a working rollback, applied on a fresh DB and a copy of the current schema`,
    );
  const risk = riskReasons(paths);
  if (risk.length)
    out.advisories.push(
      `rollback-plan: high-risk change (${risk.join('; ')}) — the MR states how it is rolled back without data loss and which production signal shows it broke`,
    );
  return out;
}
