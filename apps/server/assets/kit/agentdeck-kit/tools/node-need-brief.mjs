#!/usr/bin/env node
// node-need-brief — the project's Node first in the agent's Bash PATH, outside the panel too.
// Why (a measured review, 18.10.2026): PATH led to Node 24, the project asked for 22, and the
// path to 22 was hunted three times — both lanes and the main chat, nine calls in one lane. The panel
// now prepends it to the chat's own env; a session started from a terminal or IDE gets it here.
//
// `brief(cwd, deps)` is what the kit item `hooks/node-need-brief.mjs` runs at SessionStart. The hook's own `process.version` IS the `node` of
// the session's PATH, so nothing is spawned. Fits, no requirement, alias (`lts/*`) or unparsed range →
// silent. Otherwise the best installed match goes into CLAUDE_ENV_FILE (sourced before every Bash
// command, zero tokens per call) and one line says so; no env file → the line carries the export;
// nothing installed → the line names the install command. A version manager dir holding its OWN
// `claude` (nvm-windows global install) gets the PATH-resolved CLI dir in front of it, so `claude`
// keeps resolving where it did — unless that dir holds its own node, then nothing is changed.
import { existsSync, readdirSync, readFileSync, appendFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

const CLI_SUFFIXES = ['', '.cmd', '.exe', '.ps1', '.bat'];
const ANY = /^(lts(\/.*)?|node|stable|latest|current|system|default|\*|x)$/i;

export function parseVersion(text) {
  const m = /(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(text ?? '');
  return m ? [Number(m[1]), Number(m[2] ?? 0), Number(m[3] ?? 0)] : undefined;
}

function cmp(a, b) {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  return 0;
}

function bump(n) {
  return n.length >= 2 ? [n[0], n[1] + 1, 0] : [n[0] + 1, 0, 0];
}

/** One comparator; undefined = not understood. Same grammar as the panel's runtime-range.ts. */
function comparator(token) {
  const m = /^(>=|<=|>|<|=|\^|~=|~)?\s*(.+)$/.exec(token.trim());
  if (!m) return undefined;
  const op = m[1] ?? '';
  const n = [];
  let wild = false;
  for (const part of m[2]
    .trim()
    .replace(/^[v=]+/i, '')
    .split('.')) {
    if (/^(x|\*)$/i.test(part) || part === '') {
      wild = true;
      break;
    }
    const v = Number.parseInt(part, 10);
    if (Number.isNaN(v)) break;
    n.push(v);
  }
  if (!n.length) return op === '' && wild ? () => true : undefined;
  const base = [n[0], n[1] ?? 0, n[2] ?? 0];
  const partial = n.length < 3 || wild;
  switch (op) {
    case '>=':
      return (v) => cmp(v, base) >= 0;
    case '>':
      return partial ? (v) => cmp(v, bump(n)) >= 0 : (v) => cmp(v, base) > 0;
    case '<=':
      return partial ? (v) => cmp(v, bump(n)) < 0 : (v) => cmp(v, base) <= 0;
    case '<':
      return (v) => cmp(v, base) < 0;
    case '^': {
      const up =
        n[0] > 0
          ? [n[0] + 1, 0, 0]
          : (n[1] ?? 0) > 0 || n.length < 2
            ? [0, (n[1] ?? 0) + 1, 0]
            : [0, 0, (n[2] ?? 0) + 1];
      return (v) => cmp(v, base) >= 0 && cmp(v, up) < 0;
    }
    case '~':
    case '~=': {
      const up = n.length >= 2 ? [n[0], n[1] + 1, 0] : bump(n);
      return (v) => cmp(v, base) >= 0 && cmp(v, up) < 0;
    }
    default:
      return partial ? (v) => n.every((x, i) => v[i] === x) : (v) => cmp(v, base) === 0;
  }
}

/** true / false; undefined = the range cannot be read, which means «no requirement». */
export function satisfies(version, range) {
  let understood = false;
  for (const alt of range
    .split('||')
    .map((s) => s.trim())
    .filter(Boolean)) {
    const tokens = alt
      .replace(/&&/g, ' ')
      .replace(/(>=|<=|>|<|=|\^|~=|~)\s+(?=\d|v)/g, '$1')
      .split(/[\s,]+/)
      .filter(Boolean);
    const cs = tokens.map(comparator);
    if (cs.some((c) => !c)) continue;
    understood = true;
    if (cs.every((c) => c(version))) return true;
  }
  return understood ? false : undefined;
}

function read(file) {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
}

function wanted(text) {
  const v = text?.trim();
  return v && !ANY.test(v) && parseVersion(v) ? v : undefined;
}

/** The requirement nearest to cwd, walking up to the repo root (6 levels at most). */
export function readNeed(cwd) {
  let dir = path.resolve(cwd);
  for (let step = 0; step < 6; step++) {
    for (const name of ['.nvmrc', '.node-version']) {
      const w = wanted(read(path.join(dir, name))?.split(/\r?\n/)[0]);
      if (w) return { wanted: w, source: name };
    }
    const tv = read(path.join(dir, '.tool-versions'))
      ?.split(/\r?\n/)
      .map((l) => l.trim().split(/\s+/))
      .find((p) => p[0] === 'nodejs' || p[0] === 'node');
    const t = wanted(tv?.[1]);
    if (t) return { wanted: t, source: '.tool-versions' };
    const pkg = read(path.join(dir, 'package.json'));
    if (pkg) {
      try {
        const json = JSON.parse(pkg);
        const volta = typeof json.volta?.node === 'string' ? wanted(json.volta.node) : undefined;
        if (volta) return { wanted: volta, source: 'package.json volta' };
        const engines =
          typeof json.engines?.node === 'string' ? wanted(json.engines.node) : undefined;
        if (engines) return { wanted: engines, source: 'package.json engines' };
      } catch {
        /* a broken manifest is no requirement */
      }
    }
    if (existsSync(path.join(dir, '.git'))) break;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

function dirs(root) {
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }
}

/** Every Node a version manager installed, by directory name (no `node -v` per install). */
export function installedNodes({ env, home, platform }) {
  const win = platform === 'win32';
  const exe = win ? 'node.exe' : 'node';
  const bin = (d) => (win ? d : path.join(d, 'bin'));
  const found = [];
  const scan = (root, layout) => {
    if (!root) return;
    for (const name of dirs(root)) {
      const version = parseVersion(name);
      const dir = layout(path.join(root, name));
      if (version && existsSync(path.join(dir, exe))) found.push({ version, dir });
    }
  };
  const appData = env.APPDATA ?? path.join(home, 'AppData', 'Roaming');
  const local = env.LOCALAPPDATA ?? path.join(home, 'AppData', 'Local');
  const xdg = env.XDG_DATA_HOME ?? path.join(home, '.local', 'share');
  scan(env.NVM_HOME ?? (win ? path.join(appData, 'nvm') : undefined), (d) => d);
  scan(path.join(env.NVM_DIR ?? path.join(home, '.nvm'), 'versions', 'node'), bin);
  const fnm =
    env.FNM_DIR ??
    (win
      ? path.join(local, 'fnm')
      : platform === 'darwin'
        ? path.join(home, 'Library', 'Application Support', 'fnm')
        : path.join(xdg, 'fnm'));
  scan(path.join(fnm, 'node-versions'), (d) =>
    win ? path.join(d, 'installation') : path.join(d, 'installation', 'bin'),
  );
  scan(
    path.join(
      env.VOLTA_HOME ?? (win ? path.join(local, 'Volta') : path.join(home, '.volta')),
      'tools',
      'image',
      'node',
    ),
    bin,
  );
  scan(path.join(env.ASDF_DATA_DIR ?? path.join(home, '.asdf'), 'installs', 'nodejs'), bin);
  scan(path.join(env.MISE_DATA_DIR ?? path.join(xdg, 'mise'), 'installs', 'node'), bin);
  scan(path.join(env.NODENV_ROOT ?? path.join(home, '.nodenv'), 'versions'), bin);
  return found;
}

/** `C:\Program Files\nvm\v22` → `/c/Program Files/nvm/v22` for Git Bash; POSIX paths as they are. */
export function bashPath(dir, platform) {
  if (platform !== 'win32') return dir;
  return dir.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_, d) => `/${d.toLowerCase()}`);
}

function pathOf(env) {
  const key = Object.keys(env).find((k) => k.toLowerCase() === 'path') ?? 'PATH';
  return env[key] ?? '';
}

/** Dirs to put first, in order; undefined = nothing can be changed safely. */
export function prefixDirs(best, env, exists, delimiter) {
  const holdsCli = (d) => CLI_SUFFIXES.some((ext) => exists(path.join(d, `claude${ext}`)));
  if (!holdsCli(best.dir)) return [best.dir];
  const cliDir = pathOf(env)
    .split(delimiter)
    .find((d) => d && holdsCli(d));
  if (!cliDir || ['node', 'node.exe'].some((n) => exists(path.join(cliDir, n)))) return undefined;
  return [cliDir, best.dir];
}

const real = () => ({
  env: process.env,
  home: homedir(),
  platform: process.platform,
  current: process.version,
  exists: existsSync,
  envFile: process.env.CLAUDE_ENV_FILE,
  delimiter: path.delimiter,
});

/** One line, or null when the session's node already fits or the project asks for nothing. */
export function brief(cwd, deps = real()) {
  const need = readNeed(cwd);
  if (!need) return null;
  const current = parseVersion(deps.current);
  if (!current || satisfies(current, need.wanted) !== false) return null;
  const head = `Node: project wants ${need.wanted} (${need.source}), PATH has ${deps.current}`;
  const best = (deps.installed ?? installedNodes)(deps)
    .filter((n) => satisfies(n.version, need.wanted) === true)
    .sort((a, b) => cmp(b.version, a.version))[0];
  if (!best)
    return `${head}; no matching install found — install it (nvm install ${parseVersion(need.wanted)[0]}) or run with the default.`;
  const prefix = prefixDirs(best, deps.env, deps.exists, deps.delimiter);
  const text = best.version.join('.');
  if (!prefix)
    return `${head}; v${text} is installed but its dir would shadow the claude CLI — prefix node commands by hand.`;
  const line = `export PATH="${prefix.map((d) => bashPath(d, deps.platform)).join(':')}:$PATH"`;
  if (!deps.envFile) return `${head}; prefix node commands with: ${line}`;
  try {
    // Resume and compact fire the hook again on the same file: one line, not one per start.
    if (!(read(deps.envFile) ?? '').includes(line)) appendFileSync(deps.envFile, `${line}\n`);
  } catch {
    return `${head}; prefix node commands with: ${line}`;
  }
  return `${head}; v${text} is first in Bash PATH for this session (CLAUDE_ENV_FILE).`;
}
