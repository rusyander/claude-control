#!/usr/bin/env node
/**
 * affected — which zones of the repo a change touches, and whether the local gate may stay inside them.
 *
 * Why. CI runs everything on every push; locally the full gate of a monorepo costs minutes per run
 * and an agent pays it again after every fix. The local gate only has to cover what the change can
 * break: the touched zones and everything that depends on them. Anything the scope cannot prove
 * (root config, lockfiles, CI files, code outside every zone, no CI running tests) is FULL, with the
 * reason printed — never a silent shortcut.
 *
 * Zero-config. The zone map is derived from manifests (package.json, go.mod, pyproject.toml/setup.py,
 * Cargo.toml, gradle/maven), lockfiles and CI files, written once to `.agent/affected.map.json` and
 * rebuilt silently when the fingerprint of those files moves (one line says what changed). Human
 * overrides live in `.agent/affected.json` and are never touched by a rebuild:
 *   { "alwaysFull": ["globs"], "ignore": ["globs"], "cheapSeconds": 180,
 *     "zones": { "apps/web": { "commands": ["lint=pnpm lint", "test=pnpm test"] } } }
 *
 *   node <kit>/tools/affected.mjs                 # verdict for the working tree vs origin
 *   node <kit>/tools/affected.mjs --json          # the same as data
 *   node <kit>/tools/affected.mjs --base main     # another base ref
 *   node <kit>/tools/affected.mjs --init          # (re)build the map and print it
 *   node <kit>/tools/affected.mjs --refresh       # rebuild only if stale, silent otherwise
 *   node <kit>/tools/affected.mjs --full          # force FULL (prints the same shape)
 *
 * `gate-run --affected` consumes `computeAffected` and records timings (`<git-dir>/gate-run/timing.json`)
 * that feed the cheap-full rule here. Exit: 0 always for a verdict, 2 bad invocation.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const MAP_FILE = '.agent/affected.map.json';
export const OVERRIDE_FILE = '.agent/affected.json';
const MAP_VERSION = 1;
const MAX_DEPTH = 5;
/** Past this share of zones the scoped gate is most of the full one — run the real thing. */
const SHARE_FULL = 0.6;
/** A full gate this fast is not worth a scope that can be wrong. */
const CHEAP_SECONDS = 180;
/** Scoped estimate at this share of the measured full gate saves too little. */
const ESTIMATE_FULL = 0.8;

const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'out',
  'vendor',
  'venv',
  '.venv',
  'target',
  'coverage',
  '.agent',
  '.claude',
  'fixtures',
  '__fixtures__',
  'testdata',
  'test-fixtures',
  '.next',
  '.turbo',
]);
const ZONE_MARKERS = {
  'package.json': 'js',
  'go.mod': 'go',
  'pyproject.toml': 'python',
  'setup.py': 'python',
  'Cargo.toml': 'rust',
  'build.gradle': 'jvm',
  'build.gradle.kts': 'jvm',
  'pom.xml': 'jvm',
};
const JS_LOCKS = {
  'pnpm-lock.yaml': 'pnpm',
  'yarn.lock': 'yarn',
  'bun.lockb': 'bun',
  'bun.lock': 'bun',
  'package-lock.json': 'npm',
  'npm-shrinkwrap.json': 'npm',
};
/** Every file whose content decides zones, edges or commands — the map's fingerprint. */
const SHAPE_FILES = new Set([
  ...Object.keys(ZONE_MARKERS),
  ...Object.keys(JS_LOCKS),
  'go.sum',
  'go.work',
  'go.work.sum',
  'poetry.lock',
  'uv.lock',
  'Pipfile.lock',
  'Cargo.lock',
  'pnpm-workspace.yaml',
  'lerna.json',
  'nx.json',
  'turbo.json',
  'rush.json',
  'ruff.toml',
  '.ruff.toml',
  'pytest.ini',
  'setup.cfg',
  'tox.ini',
  'conftest.py',
  'gradlew',
  'settings.gradle',
  'settings.gradle.kts',
  'requirements.txt',
  'requirements-dev.txt',
]);
const CI_RE =
  /^(\.github\/workflows\/[^/]+\.ya?ml|\.gitlab-ci\.ya?ml|\.gitlab\/ci\/.+\.ya?ml|\.gitlab-ci\/.+\.ya?ml|\.circleci\/config\.ya?ml|azure-pipelines\.ya?ml|Jenkinsfile|bitbucket-pipelines\.ya?ml|\.travis\.ya?ml|\.drone\.ya?ml|\.woodpecker(\.ya?ml|\/.+\.ya?ml)|\.buildkite\/.+\.ya?ml)$/;
const CI_TEST_RE = /\b(test|tests|pytest|vitest|jest|mocha|unittest|tox|nox|playwright)\b/i;
const DOC_RE =
  /(\.(md|mdx|markdown|rst|adoc|txt)$|(^|\/)(LICEN[CS]E|NOTICE|AUTHORS|CODEOWNERS)(\.[^/]*)?$|^docs\/)/i;
/** Agent working folders are not product: a change there never asks for a gate. */
const AGENT_RE = /^(\.agent|\.claude)\//;

// ---- git ------------------------------------------------------------------------------------------
function git(root, argv) {
  // quotePath=false: a non-ASCII path otherwise arrives as "\320\242…" and matches no rule.
  const r = spawnSync('git', ['-c', 'core.quotePath=false', ...argv], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  });
  return r.status === 0 ? String(r.stdout) : null;
}
const lines = (text) =>
  (text ?? '')
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);

export function repoRoot(cwd = process.cwd()) {
  const top = git(cwd, ['rev-parse', '--show-toplevel']);
  return top ? top.trim() : null;
}

/** `<git-dir>/gate-run` — shared with gate-run's memo; timings live here, out of the worktree. */
export function stateDir(root) {
  const p = git(root, ['rev-parse', '--git-path', 'gate-run']);
  return p ? resolve(root, p.trim()) : null;
}

export function readTiming(root) {
  const dir = stateDir(root);
  try {
    return dir ? JSON.parse(readFileSync(`${dir}/timing.json`, 'utf8')) : {};
  } catch {
    return {};
  }
}

/** `patch` = { full?: seconds, zones?: { dir: seconds } } — merged, newest wins. */
export function writeTiming(root, patch) {
  const dir = stateDir(root);
  if (!dir) return;
  const cur = readTiming(root);
  const at = new Date().toISOString();
  if (patch.full != null) cur.full = { seconds: patch.full, at };
  if (patch.zones)
    cur.zones = {
      ...(cur.zones ?? {}),
      ...Object.fromEntries(Object.entries(patch.zones).map(([z, s]) => [z, { seconds: s, at }])),
    };
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(`${dir}/timing.json`, JSON.stringify(cur, null, 2));
  } catch {
    /* a lost timing only costs the cheap-full rule one run */
  }
}

function baseRef(root, wanted) {
  const candidates = wanted ? [wanted] : [];
  const head = git(root, ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD']);
  if (head) candidates.push(head.trim().replace(/^refs\/remotes\//, ''));
  candidates.push('origin/main', 'origin/master', 'origin/develop', 'main', 'master');
  for (const ref of candidates) {
    if (git(root, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])) return ref;
    if (wanted && ref === wanted) return null;
  }
  return null;
}

// ---- globs ----------------------------------------------------------------------------------------
function globRe(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      re += glob[i + 2] === '/' ? '(?:.*/)?' : '.*';
      i += glob[i + 2] === '/' ? 2 : 1;
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}
const matchesAny = (file, globs = []) => globs.some((g) => globRe(g).test(file));

// ---- the map --------------------------------------------------------------------------------------
const readText = (root, rel) => {
  try {
    return readFileSync(`${root}/${rel}`, 'utf8');
  } catch {
    return '';
  }
};
const readJson = (root, rel) => {
  try {
    return JSON.parse(readText(root, rel));
  } catch {
    return null;
  }
};
const skipped = (dir) => dir !== '.' && dir.split('/').some((seg) => SKIP_DIRS.has(seg));
const depth = (dir) => (dir === '.' ? 0 : dir.split('/').length);
const under = (file, dir) => dir === '.' || file === dir || file.startsWith(`${dir}/`);
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function fingerprint(root, files) {
  const h = createHash('sha256');
  for (const f of files.filter((f) => SHAPE_FILES.has(posix.basename(f)) || CI_RE.test(f)).sort()) {
    h.update(`${f}\0`);
    h.update(readText(root, f));
    h.update('\0');
  }
  return h.digest('hex').slice(0, 24);
}

function nearestLock(dir, fileSet) {
  for (let d = dir; ; d = posix.dirname(d)) {
    for (const [lock, pm] of Object.entries(JS_LOCKS))
      if (fileSet.has(d === '.' ? lock : `${d}/${lock}`)) return pm;
    if (d === '.') return 'npm';
  }
}

function zoneCommands(root, zone, fileSet) {
  const at = (name) => (zone.dir === '.' ? name : `${zone.dir}/${name}`);
  const cmds = [];
  if (zone.kinds.includes('js')) {
    const scripts = readJson(root, at('package.json'))?.scripts ?? {};
    const pm = nearestLock(zone.dir, fileSet);
    const pick = (names) =>
      names.find((n) => typeof scripts[n] === 'string' && !/no test specified/.test(scripts[n]));
    for (const [label, names] of [
      ['typecheck', ['type-check', 'typecheck']],
      ['lint', ['lint']],
      ['test', ['test:ci', 'test']],
    ]) {
      const s = pick(names);
      if (s) cmds.push({ label, cmd: `${pm} run ${s}` });
    }
  }
  if (zone.kinds.includes('go')) {
    cmds.push(
      { label: 'build', cmd: 'go build ./...' },
      { label: 'vet', cmd: 'go vet ./...' },
      { label: 'test', cmd: 'go test ./...' },
    );
  }
  if (zone.kinds.includes('python')) {
    const text = zone.manifest;
    const runner =
      fileSet.has(at('uv.lock')) || fileSet.has('uv.lock')
        ? 'uv run '
        : fileSet.has(at('poetry.lock'))
          ? 'poetry run '
          : '';
    const hasTests =
      /\[tool\.pytest|\bpytest\b/.test(text) ||
      fileSet.has(at('pytest.ini')) ||
      fileSet.has(at('conftest.py')) ||
      [...fileSet].some(
        (f) =>
          under(f, zone.dir === '.' ? 'tests' : `${zone.dir}/tests`) &&
          /test_[^/]*\.py$|_test\.py$/.test(f),
      );
    const hasRuff =
      /\[tool\.ruff/.test(text) || fileSet.has(at('ruff.toml')) || fileSet.has(at('.ruff.toml'));
    if (hasRuff) cmds.push({ label: 'lint', cmd: `${runner}ruff check .` });
    if (hasTests) cmds.push({ label: 'test', cmd: `${runner}python -m pytest -q` });
  }
  if (zone.kinds.includes('rust'))
    cmds.push({ label: 'build', cmd: 'cargo build' }, { label: 'test', cmd: 'cargo test' });
  if (zone.kinds.includes('jvm')) {
    if (fileSet.has(at('gradlew')))
      cmds.push({
        label: 'test',
        cmd: process.platform === 'win32' ? 'gradlew.bat test' : './gradlew test',
      });
    else if (fileSet.has(at('pom.xml'))) cmds.push({ label: 'test', cmd: 'mvn -q test' });
  }
  return cmds;
}

/** Does `b` name `a` in its manifest — by package/module name or by relative path? */
function dependsOn(b, a) {
  if (a.dir === b.dir) return false;
  if (a.jsName && b.jsDeps.includes(a.jsName)) return true;
  if (a.goModule && new RegExp(`(^|\\s)${esc(a.goModule)}(\\s|$)`, 'm').test(b.manifest))
    return true;
  if (a.pyName) {
    const n = a.pyName.toLowerCase().replace(/[-_.]+/g, '[-_.]');
    if (new RegExp(`(^|["'\\s])${n}(\\s*[<>=~!;\\[,"']|\\s*$)`, 'im').test(b.manifest)) return true;
  }
  if (a.rustName && new RegExp(`^\\s*${esc(a.rustName)}\\s*=`, 'm').test(b.manifest)) return true;
  const rel = posix.relative(b.dir === '.' ? '' : b.dir, a.dir === '.' ? '' : a.dir);
  return (
    rel !== '' && new RegExp(`(^|["'\\s:=])(\\./)?${esc(rel)}/?(["'\\s]|$)`, 'm').test(b.manifest)
  );
}

export function buildMap(root, files) {
  const fileSet = new Set(files);
  const byDir = new Map();
  for (const f of files) {
    const kind = ZONE_MARKERS[posix.basename(f)];
    const dir = posix.dirname(f);
    if (!kind || depth(dir) > MAX_DEPTH || skipped(dir)) continue;
    if (kind === 'js') {
      const pkg = readJson(root, f);
      if (!pkg || !(pkg.name || pkg.scripts || pkg.workspaces)) continue;
    }
    const z = byDir.get(dir) ?? { dir, kinds: [], manifest: '' };
    if (!z.kinds.includes(kind)) z.kinds.push(kind);
    byDir.set(dir, z);
  }
  const zones = [...byDir.values()].sort((a, b) => a.dir.localeCompare(b.dir));
  for (const z of zones) {
    const at = (name) => (z.dir === '.' ? name : `${z.dir}/${name}`);
    const pkg = readJson(root, at('package.json'));
    z.jsName = pkg?.name ?? null;
    const jsDeps = pkg
      ? {
          ...pkg.dependencies,
          ...pkg.devDependencies,
          ...pkg.peerDependencies,
          ...pkg.optionalDependencies,
        }
      : {};
    z.jsDeps = Object.keys(jsDeps);
    const texts = [
      'go.mod',
      'pyproject.toml',
      'setup.py',
      'requirements.txt',
      'requirements-dev.txt',
      'Cargo.toml',
      'build.gradle',
      'build.gradle.kts',
      'pom.xml',
    ].map((n) => readText(root, at(n)));
    // Dependency specs only: a script that runs `--dir apps/mobile` is not a dependency on it.
    z.manifest = [Object.values(jsDeps).join('\n'), ...texts].join('\n');
    z.goModule = readText(root, at('go.mod')).match(/^module\s+(\S+)/m)?.[1] ?? null;
    const py = readText(root, at('pyproject.toml'));
    z.pyName =
      py.match(/^\[(?:project|tool\.poetry)\][^[]*?^name\s*=\s*["']([^"']+)/ms)?.[1] ??
      readText(root, at('setup.py')).match(/name\s*=\s*["']([^"']+)/)?.[1] ??
      null;
    z.rustName =
      readText(root, at('Cargo.toml')).match(/^\[package\][^[]*?^name\s*=\s*"([^"]+)"/ms)?.[1] ??
      null;
  }
  for (const z of zones) {
    z.container = zones.some((o) => o !== z && o.dir !== '.' && under(o.dir, z.dir));
    z.dependsOn = zones.filter((a) => dependsOn(z, a)).map((a) => a.dir);
    z.commands = zoneCommands(root, z, fileSet);
  }
  const ciFiles = files.filter((f) => CI_RE.test(f));
  return {
    version: MAP_VERSION,
    note: 'GENERATED by affected.mjs — rebuilt when manifests/lockfiles/CI change; edit .agent/affected.json instead',
    generatedAt: new Date().toISOString(),
    fingerprint: fingerprint(root, files),
    packageManager: nearestLock('.', fileSet),
    ciFiles,
    ciHasTests: ciFiles.some((f) => CI_TEST_RE.test(readText(root, f))),
    zones: zones.map(
      ({ dir, kinds, container, dependsOn, commands, jsName, goModule, pyName, rustName }) => ({
        dir,
        kinds,
        name: jsName ?? goModule ?? pyName ?? rustName ?? null,
        container,
        dependsOn,
        commands,
      }),
    ),
  };
}

function describeRefresh(prev, next) {
  if (!prev) return `map built: ${next.zones.length} zone(s)`;
  const before = new Map(prev.zones.map((z) => [z.dir, z]));
  const after = new Map(next.zones.map((z) => [z.dir, z]));
  const parts = [];
  for (const d of after.keys()) if (!before.has(d)) parts.push(`+zone ${d}`);
  for (const d of before.keys()) if (!after.has(d)) parts.push(`−zone ${d}`);
  for (const [d, z] of after) {
    const old = before.get(d);
    if (old && JSON.stringify(old.commands) !== JSON.stringify(z.commands))
      parts.push(`commands changed ${d}`);
    if (old && JSON.stringify(old.dependsOn) !== JSON.stringify(z.dependsOn))
      parts.push(`edges changed ${d}`);
  }
  if (prev.ciHasTests !== next.ciHasTests)
    parts.push(`CI runs tests: ${next.ciHasTests ? 'yes' : 'no'}`);
  return `map refreshed: ${parts.join(' / ') || 'lockfile/CI content only'}`;
}

/** `.agent/` must stay out of git: excluded locally, never via .gitignore. */
function keepOutOfGit(root) {
  if (git(root, ['check-ignore', '-q', MAP_FILE]) !== null) return;
  const p = git(root, ['rev-parse', '--git-path', 'info/exclude']);
  if (!p) return;
  const file = resolve(root, p.trim());
  try {
    mkdirSync(posix.dirname(file.replace(/\\/g, '/')), { recursive: true });
    const cur = existsSync(file) ? readFileSync(file, 'utf8') : '';
    appendFileSync(file, `${cur && !cur.endsWith('\n') ? '\n' : ''}.agent/\n`);
  } catch {
    /* worst case the map shows up as untracked — and AGENT_RE keeps it out of the verdict */
  }
}

/** The map, rebuilt when its fingerprint moved. `note` is one line when something was (re)built. */
export function loadMap(root, files, { force = false, write = true } = {}) {
  const path = `${root}/${MAP_FILE}`;
  let prev = null;
  try {
    prev = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    /* absent or broken — rebuilt below */
  }
  if (!force && prev?.version === MAP_VERSION && prev.fingerprint === fingerprint(root, files))
    return { map: prev, note: null };
  const map = buildMap(root, files);
  if (write) {
    try {
      mkdirSync(`${root}/.agent`, { recursive: true });
      writeFileSync(path, `${JSON.stringify(map, null, 2)}\n`);
      keepOutOfGit(root);
    } catch {
      /* read-only checkout: the map is recomputed per run, still correct */
    }
  }
  return { map, note: describeRefresh(prev?.version === MAP_VERSION ? prev : null, map) };
}

// ---- the verdict ----------------------------------------------------------------------------------
const listFiles = (root) => lines(git(root, ['ls-files', '-co', '--exclude-standard']));

/**
 * verdict: 'full' (run the whole gate — reasons say why) · 'scoped' (zones[] with commands) ·
 * 'none' (only docs/agent files changed). `affected` lists every zone reached, whatever the verdict.
 */
export function computeAffected({ cwd = process.cwd(), base, full = false, write = true } = {}) {
  const root = repoRoot(cwd);
  if (!root)
    return {
      verdict: 'full',
      reasons: ['not a git repository'],
      zones: [],
      affected: [],
      changed: [],
      hints: [],
    };
  const files = listFiles(root);
  const { map, note } = loadMap(root, files, { write });
  const override = readJsonSafe(`${root}/${OVERRIDE_FILE}`) ?? {};
  const reasons = [];
  const hints = [];
  const out = (extra) => ({
    root,
    note,
    base: ref,
    mergeBase,
    changed,
    docs,
    reasons,
    hints,
    map,
    ...extra,
  });

  const ref = baseRef(root, base);
  const mergeBase = ref ? (git(root, ['merge-base', 'HEAD', ref])?.trim() ?? null) : null;
  let changed = [];
  let docs = [];
  if (!mergeBase) {
    reasons.push(
      base
        ? `base ref ${base} not found`
        : 'no base ref (origin/HEAD, origin/main, main…) to diff against',
    );
    return out({ verdict: 'full', zones: [], affected: [] });
  }
  changed = [
    ...new Set([
      ...lines(git(root, ['diff', '--name-only', '--no-renames', mergeBase])),
      ...lines(git(root, ['ls-files', '--others', '--exclude-standard'])),
    ]),
  ]
    .filter((f) => !AGENT_RE.test(f) && !matchesAny(f, override.ignore))
    .sort();

  /** One reason per kind, naming the first files: 60 root-owned PNGs are one fact, not 60. */
  const fileReason = (what, list) => {
    if (list.length)
      reasons.push(
        `${what}: ${list.slice(0, 3).join(', ')}${list.length > 3 ? ` (+${list.length - 3})` : ''}`,
      );
  };
  if (full) reasons.push('asked (--full)');
  fileReason(
    'alwaysFull',
    changed.filter((f) => matchesAny(f, override.alwaysFull)),
  );
  fileReason(
    'CI config changed',
    changed.filter((f) => CI_RE.test(f)),
  );
  if (!map.ciHasTests) reasons.push('no CI file runs tests — the local gate is the only one');

  docs = changed.filter((f) => DOC_RE.test(f));
  const code = changed.filter((f) => !DOC_RE.test(f));
  const zones = map.zones;
  const owner = (f) =>
    zones.filter((z) => under(f, z.dir)).sort((a, b) => depth(b.dir) - depth(a.dir))[0] ?? null;

  const hit = new Map(); // dir → why
  const outside = [];
  const rootOwned = [];
  for (const f of code) {
    const z = owner(f);
    if (!z) outside.push(f);
    else if (z.container && z.dir === '.') rootOwned.push(f);
    else if (z.container)
      for (const sub of zones.filter((s) => s !== z && under(s.dir, z.dir) && !s.container))
        hit.set(sub.dir, hit.get(sub.dir) ?? `workspace file ${f}`);
    else if (!hit.has(z.dir)) hit.set(z.dir, 'changed');
  }
  fileReason('file outside every zone', outside);
  fileReason('root-owned file', rootOwned);
  // Transitive dependents: whoever names an affected zone is affected too.
  for (let grew = true; grew;) {
    grew = false;
    for (const z of zones) {
      if (hit.has(z.dir)) continue;
      const via = z.dependsOn.find((d) => hit.has(d));
      if (via) {
        hit.set(z.dir, `depends on ${via}`);
        grew = true;
      }
    }
  }
  const affected = [...hit.keys()].sort();
  if (affected.includes('.') && zones.find((z) => z.dir === '.')?.container)
    reasons.push('the root zone depends on a changed zone');

  if (!code.length && !reasons.length) return out({ verdict: 'none', zones: [], affected: [] });

  const runnable = zones.filter((z) => !z.container);
  if (affected.length && runnable.length && affected.length / runnable.length >= SHARE_FULL) {
    reasons.push(
      `${affected.length} of ${runnable.length} zone(s) affected (≥${SHARE_FULL * 100}%)`,
    );
  }
  const commandsOf = (dir) => {
    const own = override.zones?.[dir]?.commands;
    return own ? own.map(parseGate) : (zones.find((z) => z.dir === dir)?.commands ?? []);
  };
  const scoped = affected.map((dir) => ({ dir, why: hit.get(dir), commands: commandsOf(dir) }));
  // A check kind a zone lacks but its workspace root has (lint only at the root is the usual case)
  // is inherited: the root's command covers that zone too, once per kind, or the scope drops a check.
  // A zone with override commands is complete as written — the human named exactly what covers it.
  const inherited = new Map();
  for (const z of scoped) {
    if (override.zones?.[z.dir]?.commands) continue;
    const ws = zones
      .filter((c) => c.container && c.dir !== z.dir && under(z.dir, c.dir))
      .sort((a, b) => depth(b.dir) - depth(a.dir))[0];
    if (!ws) continue;
    for (const c of commandsOf(ws.dir)) {
      if (z.commands.some((own) => own.label === c.label)) continue;
      const key = `${ws.dir}\0${c.label}`;
      if (!inherited.has(key))
        inherited.set(key, {
          dir: ws.dir,
          why: `${c.label} lives at the workspace root`,
          commands: [c],
          inheritedBy: [],
        });
      inherited.get(key).inheritedBy.push(z.dir);
    }
  }
  for (const z of scoped.filter(
    (z) =>
      !z.commands.length && ![...inherited.values()].some((i) => i.inheritedBy.includes(z.dir)),
  )) {
    reasons.push(`no commands for changed zone ${z.dir}`);
    hints.push(
      `add them in ${OVERRIDE_FILE}: { "zones": { "${z.dir}": { "commands": ["test=<command>"] } } }`,
    );
  }
  const timing = readTiming(root);
  const cheap = override.cheapSeconds ?? CHEAP_SECONDS;
  if (timing.full?.seconds != null) {
    if (timing.full.seconds <= cheap)
      reasons.push(
        `full gate measured ${Math.round(timing.full.seconds)}s ≤ ${cheap}s — cheaper than being wrong`,
      );
    else {
      const known = scoped.map((z) => timing.zones?.[z.dir]?.seconds);
      if (known.every((s) => s != null)) {
        const est = known.reduce((a, b) => a + b, 0);
        if (est >= timing.full.seconds * ESTIMATE_FULL)
          reasons.push(
            `scoped estimate ${Math.round(est)}s ≈ full ${Math.round(timing.full.seconds)}s`,
          );
      }
    }
  }
  if (reasons.length) return out({ verdict: 'full', zones: [], affected });
  return out({
    verdict: 'scoped',
    zones: [...scoped.filter((z) => z.commands.length), ...inherited.values()],
    affected,
    total: runnable.length,
  });
}

function readJsonSafe(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

/** `label=command` or a bare command — the same shape gate-run takes. */
export function parseGate(raw) {
  const m = String(raw).match(/^([\w.:-]{1,24})=(.+)$/s);
  return m
    ? { label: m[1], cmd: m[2] }
    : { label: raw.length > 28 ? `${raw.slice(0, 27)}…` : raw, cmd: raw };
}

/** The human/agent-readable verdict, a few lines. */
export function formatAffected(a) {
  const out = [];
  if (a.note) out.push(`affected: ${a.note}`);
  const where = a.base ? `base ${a.base} @ ${String(a.mergeBase).slice(0, 8)}` : 'no base';
  const counts = `${a.changed.length} changed file(s)${a.docs?.length ? `, ${a.docs.length} doc(s)` : ''}`;
  if (a.verdict === 'none')
    out.push(
      `affected: NONE — only docs/agent files changed (${where}, ${counts}); nothing to gate`,
    );
  else if (a.verdict === 'full') {
    out.push(
      `affected: FULL — ${a.reasons[0]}${a.reasons.length > 1 ? ` (+${a.reasons.length - 1} more)` : ''} (${where}, ${counts})`,
    );
    for (const r of a.reasons.slice(1, 6)) out.push(`  also: ${r}`);
    if (a.affected.length) out.push(`  zones reached: ${a.affected.join(', ')}`);
  } else {
    out.push(
      `affected: SCOPED — ${a.affected.length} of ${a.total} zone(s) (${where}, ${counts}); CI runs everything`,
    );
    for (const z of a.zones)
      out.push(`  ${z.dir} (${z.why}): ${z.commands.map((c) => c.cmd).join(' · ')}`);
  }
  for (const h of a.hints ?? []) out.push(`  hint: ${h}`);
  return out.join('\n');
}

// ---- CLI ------------------------------------------------------------------------------------------
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const flag = (n) => {
    const i = args.indexOf(n);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const cwd = flag('--cwd') ?? process.cwd();
  const root = repoRoot(cwd);
  if (args.includes('--init') || args.includes('--refresh')) {
    if (!root) {
      process.stderr.write('affected: not a git repository\n');
      process.exit(2);
    }
    const { map, note } = loadMap(root, listFiles(root), { force: args.includes('--init') });
    if (args.includes('--init')) {
      process.stdout.write(`affected: ${note} → ${MAP_FILE}\n`);
      for (const z of map.zones) {
        const tag = z.container ? ' [workspace root]' : '';
        const deps = z.dependsOn.length ? ` ← needs ${z.dependsOn.join(', ')}` : '';
        process.stdout.write(
          `  ${z.dir}${tag} (${z.kinds.join('+')})${deps}: ${z.commands.map((c) => c.cmd).join(' · ') || 'NO COMMANDS'}\n`,
        );
      }
      process.stdout.write(
        `  CI: ${map.ciFiles.join(', ') || 'none'}; runs tests: ${map.ciHasTests ? 'yes' : 'NO → always FULL'}\n`,
      );
    } else if (note) process.stdout.write(`affected: ${note}\n`);
    process.exit(0);
  }
  const result = computeAffected({ cwd, base: flag('--base'), full: args.includes('--full') });
  if (args.includes('--json')) {
    const { map: _map, ...rest } = result;
    process.stdout.write(`${JSON.stringify(rest, null, 2)}\n`);
  } else process.stdout.write(`${formatAffected(result)}\n`);
}
