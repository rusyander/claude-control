'use strict';
/**
 * Журнал проверок: ключ по СОДЕРЖИМОМУ дерева и хранилище прогонов
 * (`.agent/tmp/verify-ledger-design.agent.md` §2).
 *
 * Группы ночью 18→19.10 гоняли одни и те же гейты на одном и том же содержимом
 * по три раза (≈55 мин за ночь): после no-op rebase, на сдаче, в ревью. Ключ —
 * не sha коммита (коммит, amend и rebase без правок его меняют, содержимое —
 * нет), а дерево рабочей копии вместе со всем, что проверка читает мимо git:
 * игнорируемые `.env*`, скрытые lock-файлы `node_modules`, версия node,
 * значимые переменные окружения, сам скрипт проверки.
 *
 * Без зависимостей и синхронно: модуль грузит preload через `--require`, до
 * main, в каждом процессе node.
 */
const { execFileSync } = require('node:child_process');
const nodeCrypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { slash, gitTimeoutMs } = require('./checks.cjs');

const VERSION = 1;
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
/** Тело вывода больше — прогон не записывается: обрезанный повтор хуже прогона. */
const OUT_CAP = 2 * 1024 * 1024;
/** Неотслеживаемый файл больше — журнал молчит: `git add -A` положил бы его в объекты. */
const UNTRACKED_CAP = 5 * 1024 * 1024;
/** Старше — повтор не верим: часы, сеть и случайность ключ не видит. */
const TTL_MS = 72 * 3600e3;
/** Зелёный и красный на одном ключе за это окно — проверка нестабильна, нужно два зелёных. */
const FLAKY_MS = 14 * 24 * 3600e3;
const EVENTS_CAP = 1024 * 1024;

/**
 * Переменные, от которых зависит исход проверок. Слоты очереди, id сессий и
 * прочий шум не входят: каждый новый id давал бы новый ключ и ни одного повтора.
 */
const ENV_ALLOW = [
  /^CI$/,
  /^NODE_ENV$/,
  /^TZ$/,
  /^LANG$/,
  /^LC_ALL$/,
  /^VITE_/,
  /^VITEST_/,
  /^GO/,
  /^CGO_ENABLED$/,
  /^PYTHON/,
  /^VIRTUAL_ENV$/,
  /^NODE_OPTIONS$/,
];

/**
 * Кэши и отчёты проверок — не входы: иначе прогон менял бы собственный ключ.
 * Только glob с `**` в начале: буквальный путь (`:(exclude).agent`) к каталогу,
 * который `.gitignore` уже игнорирует, `git add` встречает отказом «paths are
 * ignored» — так 19.10 журнал молча не видел ни одного прогона копий большого проекта.
 */
const EXCLUDES = [
  ':(exclude,glob)**/.agent/**',
  ':(exclude,glob)**/node_modules/**',
  ':(exclude,glob)**/*.tsbuildinfo',
  ':(exclude,glob)**/.eslintcache',
  ':(exclude,glob)**/coverage/**',
  ':(exclude,glob)**/.vite/**',
];

/** Скрытые lock-файлы: что на самом деле стоит в `node_modules` (сам каталог не хешируем). */
const HIDDEN_LOCKS = [
  'node_modules/.package-lock.json',
  'node_modules/.modules.yaml',
  'node_modules/.pnpm/lock.yaml',
];

const sha = (data) => nodeCrypto.createHash('sha256').update(data).digest('hex');

/** Каталог в длинной форме, как его отдаёт git (на Windows cwd бывает `RUSYAN~1`). */
function realDir(dir) {
  try {
    return fs.realpathSync.native(path.resolve(dir));
  } catch {
    return path.resolve(dir);
  }
}

/** JSON с ключами по алфавиту: один и тот же набор частей — одна и та же строка. */
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

/** Без переменной — каталог, где лежит сама копия preload (`<home>/bin/<ver>/`): одна лента на всех. */
function homeDir(env = process.env) {
  if (env.AGENTDECK_VERIFY_LEDGER_HOME) return env.AGENTDECK_VERIFY_LEDGER_HOME;
  if (path.basename(path.dirname(__dirname)) === 'bin')
    return path.dirname(path.dirname(__dirname));
  return path.join(os.homedir(), '.agentdeck', 'verify-ledger');
}

/**
 * `off` — не повторять (но записывать), `shadow` — только замер, иначе `on`:
 * повтор и сужение (решение владельца 19.10 — тень за неделю не сэкономила ни минуты).
 */
function modeOf(env = process.env) {
  const v = String(env.AGENTDECK_VERIFY_LEDGER ?? '').toLowerCase();
  return v === 'off' || v === 'shadow' ? v : 'on';
}

/** Окружение git без индекса вызывающего (pre-commit lint-staged задаёт свой). */
function gitEnv(extra) {
  const { GIT_INDEX_FILE: _i, ...rest } = process.env;
  return { ...rest, ...extra };
}

function git(cwd, args, extraEnv) {
  return execFileSync('git', args, {
    cwd,
    env: gitEnv(extraEnv),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    windowsHide: true,
    maxBuffer: 256 * 1024 * 1024,
    timeout: gitTimeoutMs(),
  });
}

/**
 * Репозиторий процесса. Хранилище записей — `<git-common-dir>/agentdeck-verify`,
 * общее для основной папки и всех копий (`git worktree`): ключ — содержимое дерева,
 * а не путь, так что зелёный прогон копии годен любой копии с тем же деревом
 * (владелец 19.10: копии игнорировались, каждая гоняла всё заново). `local` —
 * своё у каждой копии, там живёт указатель «последний зелёный» для сужения.
 * `git clean` хранилище не трогает, в отпечаток дерева оно не попадает. С
 * подмодулями журнал молчит: gitlink прячет грязный подмодуль.
 */
function repoOf(cwd) {
  let lines;
  try {
    lines = git(cwd, [
      'rev-parse',
      '--show-toplevel',
      '--git-path',
      'agentdeck-verify',
      '--git-path',
      'index',
      '--git-common-dir',
    ])
      .trim()
      .split(/\r?\n/);
  } catch {
    return { off: 'not-git' };
  }
  const top = realDir(lines[0]);
  if (fs.existsSync(path.join(top, '.gitmodules'))) return { off: 'submodules', top };
  const local = path.resolve(cwd, lines[1]);
  const store = lines[3] ? path.resolve(cwd, lines[3], 'agentdeck-verify') : local;
  return { top, store, local, index: path.resolve(cwd, lines[2]) };
}

/** Строки `ls-files --debug`: путь и его mtime/size — правка с откатом меняет mtime. */
function statDigest(out) {
  const rows = [];
  let current = null;
  for (const line of out.split(/\r?\n/)) {
    if (!line.startsWith('  ')) {
      if (line) current = { p: line };
      if (current) rows.push(current);
      continue;
    }
    const m = /^\s+(mtime|size):\s*(\S+)/.exec(line);
    if (m && current) current[m[1]] = m[2];
  }
  return sha(rows.map((r) => `${r.p}\t${r.mtime}\t${r.size}`).join('\n'));
}

/**
 * Отпечаток рабочей копии: копия индекса во временный файл, затем «сырой»
 * `add -A` (без перевода концов строк и без атрибутов рабочей копии) и
 * `write-tree`. Обычный `add` при `* text=auto eol=lf` хеширует правку
 * LF→CRLF в то же дерево, а prettier и `check-lf.mjs` читают сырые байты.
 */
/** git этого процесса понимает `--attr-source`; первый отказ 129 выключает его до конца процесса. */
let attrSource = true;

function snapshot(repo) {
  const tmpDir = path.join(repo.store, 'tmp');
  fs.mkdirSync(tmpDir, { recursive: true });
  const idx = path.join(tmpDir, `idx-${process.pid}-${nodeCrypto.randomBytes(4).toString('hex')}`);
  try {
    if (fs.existsSync(repo.index)) {
      fs.copyFileSync(repo.index, idx);
      // mtime индекса — отсчёт «racy git»: запись того же размера в ту же секунду, что и
      // запись индекса, git перехеширует, только пока mtime индекса прежний. Linux и macOS
      // копируют с новым mtime, а git там сверяет секунды — правка сходила за чистую.
      const st = fs.statSync(repo.index);
      fs.utimesSync(idx, st.atime, st.mtime);
    }
    const others = git(repo.top, [
      'ls-files',
      '-o',
      '--exclude-standard',
      '-z',
      '--',
      '.',
      ...EXCLUDES,
    ])
      .split('\0')
      .filter(Boolean);
    for (const rel of others) {
      const st = fs.statSync(path.join(repo.top, rel), { throwIfNoEntry: false });
      if (st && st.size > UNTRACKED_CAP) return { off: 'untracked-large', file: rel };
    }
    const env = { GIT_INDEX_FILE: idx };
    const add = (attr) =>
      git(
        repo.top,
        [
          '-c',
          'core.autocrlf=false',
          '-c',
          'core.safecrlf=false',
          ...attr,
          'add',
          '-A',
          '--',
          '.',
          ...EXCLUDES,
        ],
        env,
      );
    if (attrSource) {
      try {
        add([`--attr-source=${EMPTY_TREE}`]);
      } catch (error) {
        // `--attr-source` — git 2.40+; старее (Apple Git 2.39, Ubuntu 22.04 — 2.34) отвечает
        // 129 «unknown option», и журнал молчал бы на каждом прогоне. Без него `.gitattributes`
        // нормализует концы строк: правка только CRLF↔LF ключ не сдвинет — на POSIX-копиях редкость.
        if (error?.status !== 129) throw error;
        attrSource = false;
        add([]);
      }
    } else add([]);
    const tree = git(repo.top, ['write-tree'], env).trim();
    const stat = statDigest(git(repo.top, ['ls-files', '--debug'], env));
    return { tree, stat };
  } finally {
    fs.rmSync(idx, { force: true });
  }
}

/** Дерево merge-base для проверок «относительно основной ветки»: двинулась база — другой ключ. */
function baseTree(repo, ref) {
  try {
    const mb = git(repo.top, ['merge-base', 'HEAD', ref]).trim();
    return git(repo.top, ['rev-parse', `${mb}^{tree}`]).trim();
  } catch {
    return 'none';
  }
}

function fileDigest(file) {
  try {
    return sha(fs.readFileSync(file));
  } catch {
    return 'absent';
  }
}

/** Каталог целиком (без `node_modules` и `.git`); слишком большой — `null`, журнал молчит. */
function dirDigest(dir, cap = 2000) {
  const rows = [];
  const walk = (d) => {
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name === 'node_modules' || e.name === '.git') continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) {
        rows.push(`${slash(path.relative(dir, p))}\t${fileDigest(p)}`);
        if (rows.length > cap) throw new Error('dir-too-large');
      }
    }
  };
  try {
    walk(dir);
  } catch {
    return null;
  }
  return sha(rows.sort().join('\n'));
}

/** Ближайший к cwd каталог с `package.json` внутри репозитория — его `.env*` и lock-файлы. */
function packageDir(top, cwd) {
  let dir = path.resolve(cwd);
  while (dir.startsWith(top)) {
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir;
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return top;
}

/** Игнорируемые входы, которые читает любая проверка JS: `.env*` и скрытые lock-файлы. */
function ignoredInputs(top, cwd, declared) {
  const out = {};
  for (const dir of [...new Set([top, packageDir(top, cwd)])]) {
    let names = [];
    try {
      names = fs.readdirSync(dir).filter((n) => /^\.env/.test(n));
    } catch {
      /* каталога нет — и входов нет */
    }
    for (const n of [...names, ...HIDDEN_LOCKS]) {
      const p = path.join(dir, n);
      out[slash(path.relative(top, p))] = fileDigest(p);
    }
  }
  for (const rel of declared ?? []) {
    const p = path.resolve(top, rel);
    const st = fs.statSync(p, { throwIfNoEntry: false });
    out[slash(rel)] = st?.isDirectory() ? (dirDigest(p) ?? 'too-large') : fileDigest(p);
  }
  return out;
}

/**
 * Наш `--require` из NODE_OPTIONS не в ключе: иначе ключ зависел бы от версии журнала.
 * Preload `local-overlay` — тоже обвязка машины, не вход проверки: одна сессия держала
 * его в NODE_OPTIONS, группа сняла, и тот же прогон на том же дереве давал другой
 * ключ — ни одного попадания у группы за вечер (журнал 19.10 20:23).
 */
function stripPreload(value) {
  return String(value ?? '')
    .replace(
      /--require[= ]("[^"]*(?:verify-ledger|local-overlay)[^"]*"|\S*(?:verify-ledger|local-overlay)\S*)/g,
      '',
    )
    .replace(/\s+/g, ' ')
    .trim();
}

function envPart(env, extra) {
  const out = {};
  for (const [k, v] of Object.entries(env)) {
    if (!ENV_ALLOW.some((re) => re.test(k)) && !(extra ?? []).includes(k)) continue;
    const value = k === 'NODE_OPTIONS' ? stripPreload(v) : v;
    if (value) out[k] = sha(String(value));
  }
  return out;
}

/** Аргументы без машинных путей: абсолютный путь внутри репозитория — относительный. */
function normalizeArgs(args, top) {
  // Регистр складывается только там, где его не различает диск: на Linux соседний `Proj`
  // рядом с `proj` — другой каталог, и срезанный префикс дал бы двум аргументам один ключ.
  const caseless = process.platform === 'win32' || process.platform === 'darwin';
  const fold = (text) => (caseless ? text.toLowerCase() : text);
  const topSlash = fold(`${slash(top)}/`);
  return args.map((a) => {
    const s = slash(a);
    return fold(s).startsWith(topSlash) ? s.slice(topSlash.length) : s;
  });
}

/** Путь файла отчёта не меняет того, что проверено: в ключе — метка вместо пути. */
function maskReports(args, reports) {
  if (!reports?.length) return args;
  const out = [...args];
  for (const r of reports) out[r.at] = r.sep ? '<report>' : `${r.flag}=<report>`;
  return out;
}

/**
 * Артефакты текущего запуска: отчёты и каталоги сборки. Байты пишутся в запись,
 * повтор кладёт их по путям ЭТОГО запуска.
 */
const reportArtifacts = (match) => [
  ...(match.reports ?? []).map((r, i) => ({ report: i, path: r.file })),
  ...(match.outputs ?? []).map((dir, i) => ({ output: i, dir })),
];

/** Запись годится для запуска с отчётами и сборкой, только если в ней есть байты каждого. */
const coversReports = (record, match) =>
  (match.reports ?? []).every((_, i) =>
    (record.art ?? []).some((a) => a.spec?.report === i && !a.absent),
  ) &&
  (match.outputs ?? []).every((_, i) =>
    (record.art ?? []).some((a) => a.spec?.output === i && !a.absent && !a.unusable),
  );

/** Каталог сборки больше этого не хранится: повтор не должен стоить гигабайт. */
const DIR_CAP = 64 * 1024 * 1024;

/**
 * Каталог сборки одним сжатым файлом: строка-оглавление `[[путь, байт], …]`, затем
 * байты подряд. `null` — каталога нет, он больше предела или прогон в нём ничего не
 * написал (сборка ушла в другой каталог — повторять было бы нечего).
 */
function packDir(dir, since) {
  const rows = [];
  let total = 0;
  let fresh = false;
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) {
        const st = fs.statSync(p);
        total += st.size;
        if (total > DIR_CAP) throw new Error('dir-cap');
        if (st.mtimeMs >= since - 2000) fresh = true;
        rows.push({ p: slash(path.relative(dir, p)), body: fs.readFileSync(p) });
      }
    }
  };
  try {
    walk(dir);
  } catch {
    return null;
  }
  if (rows.length === 0 || !fresh) return null;
  const head = Buffer.from(`${JSON.stringify(rows.map((r) => [r.p, r.body.length]))}\n`);
  return zlib.gzipSync(Buffer.concat([head, ...rows.map((r) => r.body)]));
}

/** Каталог сборки на место — ровно таким, каким был записан: прежнее содержимое снимается. */
function unpackDir(packed, dir) {
  const raw = zlib.gunzipSync(packed);
  const nl = raw.indexOf(10);
  const list = JSON.parse(raw.subarray(0, nl).toString('utf8'));
  const rootDir = path.resolve(dir);
  fs.rmSync(rootDir, { recursive: true, force: true });
  let at = nl + 1;
  for (const [rel, size] of list) {
    const file = path.resolve(rootDir, rel);
    if (!file.startsWith(rootDir + path.sep)) throw new Error('artifact path escapes its dir');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, raw.subarray(at, at + size));
    at += size;
  }
}

/** Конфиги пакета, в которых живут пути к соседям (paths, alias, extends). */
const SCOPE_CONFIG =
  /^(tsconfig[^/]*\.json|(vite|vitest)[^/]*\.(config|workspace)\.[cm]?[jt]s|eslint\.config\.[cm]?[jt]s|\.eslintrc[^/]*|\.prettierrc[^/]*|prettier\.config\.[cm]?[jt]s|package\.json)$/;

/**
 * Дерево, которое видит общий инструмент в пакете монорепо: сам пакет, связанные
 * пакеты рабочей области, каталоги из `../`-путей его конфигов и файлы корня.
 * Правка в чужом пакете ключ не меняет (19.10: правка mdx в inst-docs-ui гнала
 * tsc/eslint/prettier всех пакетов). Чего не разобрать — всё дерево целиком.
 *
 * vitest — всегда всё дерево: тест исполняет что угодно по пути из своего кода
 * (скрипт `tools/*.mjs` дочерним процессом, фикстуру соседнего каталога), а
 * таких путей нет ни в одном конфиге. С узким ключом правка такого скрипта
 * отдавала старый зелёный вместо прогона (20.10: тест `tests-cli` в
 * `apps/server` повторялся после правки `tools/tests-cli.mjs`).
 */
function scopeTree(repo, tree, cwd, match) {
  if (match.entry || !tree || match.id === 'vitest') return tree;
  const top = realDir(repo.top);
  const pkgAbs = realDir(cwd);
  const pkgRel = slash(path.relative(top, pkgAbs));
  if (!pkgRel || pkgRel.startsWith('..') || !fs.existsSync(path.join(pkgAbs, 'package.json')))
    return tree;
  const dirs = new Set([pkgRel, ...require('./delta.cjs').linkedDirs(top, pkgAbs)]);
  for (const name of fs.readdirSync(pkgAbs)) {
    if (!SCOPE_CONFIG.test(name)) continue;
    let text;
    try {
      text = fs.readFileSync(path.join(pkgAbs, name), 'utf8');
    } catch {
      return tree;
    }
    for (const m of text.matchAll(/['"`](\.\.\/[^'"`*]*)/g)) {
      const rel = slash(path.relative(top, path.resolve(pkgAbs, m[1])));
      if (rel.startsWith('..')) return tree;
      // Каталог верхнего уровня целиком — грубо, зато без догадок о вложенности;
      // файл корня (`../tsconfig.base.json`) и так в ключе.
      const first = rel.split('/')[0];
      if (!rel) return tree;
      if (fs.statSync(path.join(top, first), { throwIfNoEntry: false })?.isDirectory())
        dirs.add(first);
    }
  }
  let listing;
  try {
    const roots = git(top, ['ls-tree', tree])
      .split('\n')
      .filter((l) => / blob /.test(l));
    listing = [...roots, git(top, ['ls-tree', tree, '--', ...[...dirs].sort()])].join('\n');
  } catch {
    return tree;
  }
  return `scope:${sha(listing)}`;
}

/**
 * Части ключа. Скрипт проверки: общий инструмент — сам файл (версия пакета
 * уже в скрытом lock-файле); проверка проекта — весь её каталог и запись
 * реестра: машинерия обычно вне git и в дерево не попадает.
 */
function keyParts({
  repo,
  match,
  cwd: rawCwd,
  tree,
  env = process.env,
  execArgv = process.execArgv,
}) {
  // Короткий путь Windows (`RUSYAN~1`) не начинается с длинного корня от git: без
  // приведения `.env` пакета выпадал из ключа, а один запуск давал два разных ключа.
  const cwd = realDir(rawCwd);
  const entry = match.entry;
  const script = entry
    ? {
        dir: dirDigest(path.dirname(match.script)) ?? 'too-large',
        registry: sha(entry.registryRaw),
        machinery: ignoredInputs(repo.top, cwd, entry.machinery),
      }
    : { file: fileDigest(match.script) };
  return {
    v: VERSION,
    check: match.id,
    args: normalizeArgs(maskReports(match.args, match.reports), repo.top),
    cwd: slash(path.relative(repo.top, path.resolve(cwd))),
    tree: scopeTree(repo, tree, cwd, match),
    base: entry?.base ? baseTree(repo, entry.base) : null,
    ignored: ignoredInputs(repo.top, cwd, entry?.inputs),
    tool: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      execArgv: execArgv.filter((a) => !/verify-ledger/.test(a)),
    },
    env: envPart(env, entry?.env),
    script,
  };
}

const keyOf = (parts) => sha(canonical(parts));

/** Проверка без дерева: тот же запуск в том же месте — для метки нестабильности. */
const checkIdOf = (parts) =>
  sha(canonical({ check: parts.check, args: parts.args, cwd: parts.cwd })).slice(0, 24);

function hmacKey() {
  const file = path.join(homeDir(), 'key');
  try {
    return fs.readFileSync(file);
  } catch {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    try {
      fs.writeFileSync(file, nodeCrypto.randomBytes(32), { flag: 'wx', mode: 0o600 });
    } catch {
      /* соседний процесс создал первым */
    }
    return fs.readFileSync(file);
  }
}

const sign = (record) => {
  const { hmac: _h, ...body } = record;
  return nodeCrypto.createHmac('sha256', hmacKey()).update(canonical(body)).digest('hex');
};

function verify(record) {
  if (!record || typeof record.hmac !== 'string') return false;
  const want = Buffer.from(sign(record), 'hex');
  const got = Buffer.from(record.hmac, 'hex');
  return want.length === got.length && nodeCrypto.timingSafeEqual(want, got);
}

const runsDir = (repo, key) => path.join(repo.store, `v${VERSION}`, 'runs', key.slice(0, 2));
const outFile = (repo, runId, stream) =>
  path.join(repo.store, `v${VERSION}`, 'out', `${runId}.${stream}.gz`);
const artDir = (repo, runId) => path.join(repo.store, `v${VERSION}`, 'art', runId);
const flakyFile = (repo, checkId) =>
  path.join(repo.store, `v${VERSION}`, 'flaky', `${checkId}.json`);

/** Все подписанные записи ключа; чужой или правленый руками JSON не считается. */
function records(repo, key) {
  const dir = runsDir(repo, key);
  let names;
  try {
    names = fs.readdirSync(dir).filter((n) => n.startsWith(`${key}.`) && n.endsWith('.json'));
  } catch {
    return [];
  }
  const out = [];
  for (const n of names) {
    try {
      const r = JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8'));
      if (r.key === key && verify(r)) out.push(r);
    } catch {
      /* недописанный или битый файл — не запись */
    }
  }
  return out;
}

function isFlaky(repo, checkId, now) {
  const st = fs.statSync(flakyFile(repo, checkId), { throwIfNoEntry: false });
  return Boolean(st && now - st.mtimeMs < FLAKY_MS);
}

/**
 * Можно ли ответить записью вместо прогона. Красный на ключе хоть раз — никогда:
 * «последняя запись побеждает» спрятала бы красный за случайным зелёным.
 */
function decide(repo, key, { now = Date.now(), flaky = false } = {}) {
  const all = records(repo, key);
  if (all.length === 0) return { hit: null, reason: 'no-record' };
  if (all.some((r) => r.exit !== 0)) return { hit: null, reason: 'red-at-key' };
  const greens = all.filter((r) => !r.reusedFrom).sort((a, b) => b.startedAt - a.startedAt);
  if (greens.length < (flaky ? 2 : 1))
    return { hit: null, reason: flaky ? 'flaky-needs-two' : 'no-green' };
  const newest = greens[0];
  if (now - newest.startedAt > TTL_MS) return { hit: null, reason: 'stale' };
  if (!newest.out?.complete) return { hit: null, reason: 'output-incomplete' };
  for (const s of ['stdout', 'stderr']) {
    if (!fs.existsSync(outFile(repo, newest.runId, s)))
      return { hit: null, reason: 'output-missing' };
  }
  for (const a of newest.art ?? []) {
    if (a.unusable) return { hit: null, reason: 'artifact-unusable' };
    if (!a.absent && !fs.existsSync(path.join(artDir(repo, newest.runId), String(a.i)))) {
      return { hit: null, reason: 'artifact-missing' };
    }
  }
  return { hit: newest, reason: 'hit' };
}

function writeAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${nodeCrypto.randomBytes(3).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

/** Файл артефакта: `gitPath` — внутри `.git` (штампы гейтов), `path` — от корня репозитория. */
function artifactPath(repo, spec) {
  if (spec.gitPath)
    return path.resolve(repo.top, git(repo.top, ['rev-parse', '--git-path', spec.gitPath]).trim());
  return path.resolve(repo.top, spec.path);
}

/**
 * Запись прогона: один файл на прогон (append-only) — красный и зелёный,
 * закончившиеся разом, не затирают друг друга. Вывод — отдельно, сжатым.
 */
function writeRecord(repo, record, { stdout, stderr, complete }, artifacts = []) {
  const runId = `${Date.now().toString(36)}-${process.pid}-${nodeCrypto.randomBytes(3).toString('hex')}`;
  writeAtomic(outFile(repo, runId, 'stdout'), zlib.gzipSync(stdout));
  writeAtomic(outFile(repo, runId, 'stderr'), zlib.gzipSync(stderr));
  const art = artifacts.map((spec, i) => {
    if (spec.dir !== undefined) {
      // Каталог сборки — только внутри репозитория и не сам его корень. Короткий путь
      // Windows (`RUSYAN~1`) у cwd против длинного корня от git — тот же каталог.
      const rel = slash(path.relative(repo.top, realDir(spec.dir)));
      const stored = { output: spec.output, dir: rel };
      if (!rel || rel.startsWith('..') || path.isAbsolute(rel))
        return { i, spec: stored, unusable: true };
      const packed = packDir(spec.dir, record.startedAt ?? Date.now());
      if (!packed) return { i, spec: stored, unusable: true };
      writeAtomic(path.join(artDir(repo, runId), String(i)), packed);
      return { i, spec: stored, sha: sha(packed) };
    }
    const src = artifactPath(repo, spec);
    if (!fs.existsSync(src)) return { i, spec, absent: true };
    const body = fs.readFileSync(src);
    writeAtomic(path.join(artDir(repo, runId), String(i)), body);
    return { i, spec, sha: sha(body) };
  });
  const full = {
    ...record,
    v: VERSION,
    runId,
    out: { stdout: sha(stdout), stderr: sha(stderr), complete: Boolean(complete) },
    art,
  };
  full.hmac = sign(full);
  writeAtomic(
    path.join(runsDir(repo, record.key), `${record.key}.${runId}.json`),
    JSON.stringify(full),
  );
  markFlaky(repo, record);
  return full;
}

/** Зелёный и красный на одном ключе за 14 дней — проверка нестабильна. */
function markFlaky(repo, record) {
  if (record.reusedFrom) return;
  const recent = records(repo, record.key).filter((r) => record.startedAt - r.startedAt < FLAKY_MS);
  const exits = new Set(recent.map((r) => (r.exit === 0 ? 'g' : 'r')));
  if (exits.size === 2)
    writeAtomic(flakyFile(repo, record.checkId), JSON.stringify({ at: Date.now() }));
}

/** Повтор: артефакты на место, вывод как был, код как был. */
function replayBodies(repo, hit, match = null) {
  for (const a of hit.art ?? []) {
    if (a.spec?.dir !== undefined) {
      const dir = match?.outputs?.[a.spec.output] ?? path.resolve(repo.top, a.spec.dir);
      unpackDir(fs.readFileSync(path.join(artDir(repo, hit.runId), String(a.i))), dir);
      continue;
    }
    // Отчёт — по пути этого запуска, не того, что записан.
    const current = a.spec?.report !== undefined ? match?.reports?.[a.spec.report] : null;
    const dst = current ? current.file : artifactPath(repo, a.spec);
    if (a.absent) fs.rmSync(dst, { force: true });
    else {
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.copyFileSync(path.join(artDir(repo, hit.runId), String(a.i)), dst);
    }
  }
  return {
    stdout: zlib.gunzipSync(fs.readFileSync(outFile(repo, hit.runId, 'stdout'))),
    stderr: zlib.gunzipSync(fs.readFileSync(outFile(repo, hit.runId, 'stderr'))),
  };
}

/** Лента событий для панели: что записано, что повторено бы, где тень разошлась с прогоном. */
function appendEvent(event, env = process.env) {
  try {
    const file = path.join(homeDir(env), 'events.jsonl');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const st = fs.statSync(file, { throwIfNoEntry: false });
    if (st && st.size > EVENTS_CAP) fs.renameSync(file, `${file}.1`);
    fs.appendFileSync(file, `${JSON.stringify({ at: Date.now(), ...event })}\n`);
  } catch {
    /* лента — для замера; её сбой не трогает проверку */
  }
}

/**
 * Пульс покрытия: под каким CLI preload реально загрузился (метку ставит
 * панель). CLI, вычищающий окружение, пульса не даст — панель покажет «не виден».
 */
function heartbeat(env = process.env) {
  const cli = env.AGENTDECK_VERIFY_LEDGER_CLI;
  if (!cli || !/^[\w.-]+$/.test(cli)) return;
  try {
    const file = path.join(homeDir(env), 'seen', `${cli}.json`);
    const st = fs.statSync(file, { throwIfNoEntry: false });
    if (st && Date.now() - st.mtimeMs < 10 * 60e3) return;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ cli, at: Date.now(), pid: process.pid }));
  } catch {
    /* пульс — для замера */
  }
}

module.exports = {
  VERSION,
  OUT_CAP,
  TTL_MS,
  homeDir,
  modeOf,
  repoOf,
  snapshot,
  keyParts,
  keyOf,
  checkIdOf,
  records,
  isFlaky,
  decide,
  writeRecord,
  replayBodies,
  reportArtifacts,
  coversReports,
  appendEvent,
  heartbeat,
  stripPreload,
  canonical,
  verify,
};
