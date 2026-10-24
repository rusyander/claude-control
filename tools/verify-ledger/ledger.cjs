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
const { slash, gitTimeoutMs, entryLock, panelLocked } = require('./checks.cjs');

const VERSION = 1;
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
/** Тело вывода больше — прогон не записывается: обрезанный повтор хуже прогона. */
const OUT_CAP = 2 * 1024 * 1024;
/** Неотслеживаемый файл больше — журнал молчит: `git add -A` положил бы его в объекты. */
const UNTRACKED_CAP = 5 * 1024 * 1024;
/**
 * Срок записи — от ПОСЛЕДНЕГО использования (запись или повтор на её ключе), не от записи:
 * повтор продлевает её. Пока жива работа, в которой ключ писали или повторяли (каталог
 * копии на месте и её ветка есть), запись не стареет вовсе (владелец 24.10: журнал
 * держит записи, пока жива работа, — до уборки группы или сдачи задачи). Прежде 72 ч
 * считались от записи, и долгая группа теряла свои зелёные посреди работы.
 */
const TTL_MS = 72 * 3600e3;
/**
 * Предел хранилища (`<git-common-dir>/agentdeck-verify`) — общий у основной папки и копий.
 * 24.10 хранилища трёх репозиториев весили 24–56 МБ за пять дней без единой уборки, а
 * сборки vite с `outDir` в конфиге теперь хранят каталог сборки (у большого проекта
 * ≈19 МБ сжатыми на один набор). Сверх предела уходят ключи, дольше всех не
 * использованные (мёртвые уже ушли по сроку), до 3/4 предела. Повторы приходят в
 * пределах часов от записи (24.10: самый долгий разрыв — 8 ч), так что вытеснение по
 * давности использования их не задевает. `AGENTDECK_VERIFY_LEDGER_CAP_MB` — для тестов.
 */
const STORE_CAP = 1024 * 1024 * 1024;
/** Уборка хранилища из preload — не чаще этого: обход 4–8 тыс. файлов стоит до секунды. */
const PRUNE_EVERY_MS = 3600e3;
/** Файл моложе этого уборка не трогает: соседний процесс мог ещё не дописать свою запись. */
const PRUNE_GRACE_MS = 10 * 60e3;
/** Зелёный и красный на одном ключе за это окно — проверка нестабильна, нужно два зелёных. */
const FLAKY_MS = 14 * 24 * 3600e3;
const EVENTS_CAP = 1024 * 1024;

/**
 * Окружение входит в ключ ЦЕЛИКОМ, кроме учёта сессии. Прежний список «нужных» переменных
 * (24.10) пропустил мутанта: конфиг проверки грузил хук из своей переменной, и прогон с
 * мутантом получил записанный зелёный прогона-тождества. Здесь — только то, что меняется от
 * сессии к сессии и исхода проверки не трогает: каждый новый id давал бы новый ключ и ни
 * одного повтора. Имя из записи реестра (`env`) входит в ключ, даже если оно в этом списке.
 */
const ENV_SESSION = [
  /^AGENTDECK_(VERIFY_LEDGER|GROUP_|HEAVY_|TESTS_|MARK_|KIT_)/i,
  /^AGENTDECK_(SPLIT_CHILD|URL|BRIEF_OUTPUT|JUNIT_REPORT|WATCH_REPORT|AUTONOMOUS|LEVER)$/i,
  /^CLAUDE_CODE_/i,
  /^CLAUDECODE$/i,
  /^CLAUDE_(PID|EFFORT|AGENT_SDK_VERSION|ENV_FILE|PROJECT_DIR)$/i,
  /^VSCODE_/i,
  /^EFC_\d+_\d+$/i,
  /^(CHROME_CRASHPAD_PIPE_NAME|ELECTRON_RUN_AS_NODE|GIT_ASKPASS)$/i,
  /^FPS_BROWSER_/i,
  /^TERM_PROGRAM/i,
  /^(TERM_SESSION_ID|ITERM_SESSION_ID|WT_SESSION|WT_PROFILE_ID|WINDOWID|STY)$/i,
  /^(PWD|OLDPWD|SHLVL|_)$/i,
  /^SSH_(AUTH_SOCK|AGENT_PID|CLIENT|CONNECTION|TTY)$/i,
  /^TMUX/i,
  /^KITTY_/i,
  /^(DBUS_SESSION_BUS_ADDRESS|XDG_SESSION_ID|XDG_SESSION_COOKIE)$/i,
  // Запуск через npm/pnpm/yarn: учёт пакетного менеджера, не вход (сам PATH — ниже, по разрешению).
  /^npm_/i,
  /^(INIT_CWD|PNPM_SCRIPT_SRC_DIR|NODE)$/i,
  // Их же ставят npm (COLOR, EDITOR), pnpm, yarn и cmd.exe под `shell` (PROMPT) — замер 24.10:
  // без этого прямой запуск и `npm run` того же скрипта на том же дереве не делили ключ.
  /^(COLOR|EDITOR|PROMPT|YARN_WRAP_OUTPUT|PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN)$/i,
];
/** Каталог обёрток `yarn run` (yarn 1): `node.cmd`/`yarn.cmd` в нём ведут на тот же node, что запустил yarn. */
const PM_SHIM_DIR = /^yarn--\d+-[\d.]+$/;

/**
 * PATH в ключ входит не строкой, а тем, во что разрешаются эти имена: строка у каждой
 * поверхности своя (VS Code, панель, терминал, `pnpm run` дописывают свои каталоги), а
 * подмена `npx` первым каталогом PATH — другой исполняемый файл, и прогон обязан идти.
 */
const PATH_TOOLS = [
  'node',
  'npm',
  'npx',
  'pnpm',
  'yarn',
  'git',
  'bash',
  'sh',
  'python',
  'python3',
  'go',
];
/** Обёртка меньше этого — по содержимому (временный каталог yarn), больше — путь, размер, mtime. */
const SHIM_CAP = 64 * 1024;

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
  // Под замком входа (F-30) дом — тот, что поставила панель: свежий дом из команды модели
  // не хранил бы ни зелёного для повтора, ни ключа подписи — то же выключение журнала.
  const lock = entryLock();
  if (lock) return lock.home;
  if (env.AGENTDECK_VERIFY_LEDGER_HOME) return env.AGENTDECK_VERIFY_LEDGER_HOME;
  if (path.basename(path.dirname(__dirname)) === 'bin')
    return path.dirname(path.dirname(__dirname));
  return path.join(os.homedir(), '.agentdeck', 'verify-ledger');
}

/**
 * Замок панели: вход `bin/preload-locked.cjs` (F-30; окружением команды не снять) или
 * `AGENTDECK_VERIFY_LEDGER_LOCK=1`. Под ним `off`, `shadow`, `_DELTA=off` и чужой `_HOME` не
 * действуют. Снимает замок только свой инструмент, которому повтор ломает суть (мутации
 * mustfail), — обычным входом и пустым `_LOCK` в окружении своих прогонов.
 */
function locked(env = process.env) {
  return panelLocked(env);
}

/**
 * `off` — не повторять (но записывать), `shadow` — только замер, иначе `on`:
 * повтор и сужение (решение владельца 19.10 — тень за неделю не сэкономила ни минуты).
 */
function modeOf(env = process.env) {
  // Замок панели: модель под панелью не выключает повтор переменной в своей команде
  // (владелец 23.10 — группа обходила журнал и гоняла тот же гейт заново).
  if (locked(env)) return 'on';
  const v = String(env.AGENTDECK_VERIFY_LEDGER ?? '').toLowerCase();
  return v === 'off' || v === 'shadow' ? v : 'on';
}

/** Окружение git без индекса вызывающего (pre-commit lint-staged задаёт свой). */
function gitEnv(extra) {
  const { GIT_INDEX_FILE: _i, ...rest } = process.env;
  return { ...rest, ...extra };
}

/** `keepStderr` — stderr в ошибку (`error.stderr`): причина сбоя попадает в ленту, а не теряется. */
function git(cwd, args, extraEnv, { keepStderr = false } = {}) {
  return execFileSync('git', args, {
    cwd,
    env: gitEnv(extraEnv),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', keepStderr ? 'pipe' : 'ignore'],
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
      '--git-path',
      'HEAD',
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
  const head = lines[4] ? path.resolve(cwd, lines[4]) : null;
  return { top, store, local, index: path.resolve(cwd, lines[2]), head };
}

/**
 * Чья это работа: каталог копии и её ветка (`null` — HEAD отвязан). Читается файл HEAD,
 * а не `rev-parse HEAD`: в репозитории без коммитов тот падает, и журнал счёл бы его не-git.
 */
function workOf(repo) {
  let branch = null;
  try {
    const m = /^ref:\s*refs\/heads\/(.+?)\s*$/m.exec(fs.readFileSync(repo.head, 'utf8'));
    if (m) branch = m[1];
  } catch {
    /* HEAD не прочитан — ветка неизвестна, жива ли работа, решит каталог */
  }
  return { top: slash(repo.top), branch };
}

/**
 * Путь для сравнения: длинная форма (убранной копии уже нет — по ближайшему живому
 * предку: `RUSYAN~1` против длинного пути записи), слеши вперёд, регистр складывается
 * там, где его не различает диск.
 */
function samePathKey(p) {
  let head = path.resolve(p);
  const tail = [];
  while (!fs.existsSync(head) && path.dirname(head) !== head) {
    tail.unshift(path.basename(head));
    head = path.dirname(head);
  }
  const s = slash(path.join(realDir(head), ...tail)).replace(/\/+$/, '');
  return process.platform === 'win32' || process.platform === 'darwin' ? s.toLowerCase() : s;
}

/**
 * Жива ли работа записи: её каталог — всё ещё копия git (`.git` на месте) и её ветка есть.
 * `removed` — каталоги, которые панель только что убрала (уборка группы): мертвы сразу.
 * Сбой git, кроме ответа «ветки нет», — «жива»: уборка не должна снести живое из-за
 * зависшего git, а повтор от этого не становится менее верным — ключ тот же.
 */
function workAlive(repo, wt, { removed = null, cache = new Map() } = {}) {
  if (!wt || typeof wt.top !== 'string' || !wt.top) return false;
  const id = `${samePathKey(wt.top)}\0${wt.branch ?? ''}`;
  if (cache.has(id)) return cache.get(id);
  let alive = !removed?.has(samePathKey(wt.top)) && fs.existsSync(path.join(wt.top, '.git'));
  if (alive && wt.branch) {
    try {
      git(repo.top, ['show-ref', '--verify', '--quiet', `refs/heads/${wt.branch}`]);
    } catch (error) {
      if (error?.status === 1) alive = false;
    }
  }
  cache.set(id, alive);
  return alive;
}

/** Последнее использование ключа: самая свежая его запись, повторы включительно. */
const lastUseOf = (all) => all.reduce((max, r) => Math.max(max, Number(r.startedAt) || 0), 0);

/**
 * Не постарел ли ключ: использован в пределах `TTL_MS` или хоть одна его запись
 * (прогон или повтор) — из живой работы. Записи до 24.10 работы не знают — им только срок.
 */
function keyFresh(repo, all, now, opts = {}) {
  if (now - lastUseOf(all) <= TTL_MS && !opts.removed?.size) return true;
  const cache = opts.cache ?? new Map();
  const alive = all.some((r) => workAlive(repo, r.wt, { removed: opts.removed, cache }));
  if (alive) return true;
  // Уборка копии: ключ, к которому прикасалась ТОЛЬКО убранная работа, уходит сразу.
  if (opts.removed?.size && all.some((r) => r.wt && opts.removed.has(samePathKey(r.wt.top))))
    return false;
  return now - lastUseOf(all) <= TTL_MS;
}

/** Строки `ls-files --debug`: путь и его mtime/size — правка с откатом меняет mtime. */
function statRows(out) {
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
  return rows;
}

/** Отпечаток строк `statRows`; `keep` — только пути области проверки. */
function statDigest(rows, keep = null) {
  const picked = keep ? rows.filter((r) => keep(r.p)) : rows;
  return sha(picked.map((r) => `${r.p}\t${r.mtime}\t${r.size}`).join('\n'));
}

/**
 * Отпечаток рабочей копии: копия индекса во временный файл, затем «сырой»
 * `add -A` (без перевода концов строк и без атрибутов рабочей копии) и
 * `write-tree`. Обычный `add` при `* text=auto eol=lf` хеширует правку
 * LF→CRLF в то же дерево, а prettier и `check-lf.mjs` читают сырые байты.
 */
/** git этого процесса понимает `--attr-source`; первый отказ 129 выключает его до конца процесса. */
let attrSource = true;
/** Попыток `git add` у снимка: сбой от файла, исчезнувшего на лету, второй попыткой проходит. */
const SNAPSHOT_TRIES = 3;

/**
 * Хвост stderr упавшего git для события ленты: последние непустые строки, не длиннее 240
 * знаков. Первая строка ошибки — сама команда, причина (`unable to index file …`) — в хвосте.
 */
function stderrTail(error) {
  const lines = String(error?.stderr ?? '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  return lines.length ? lines.slice(-3).join(' | ').slice(-240) : null;
}

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
    const addOnce = (attr) =>
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
        { keepStderr: true },
      );
    // Файл, исчезнувший между обходом каталога и чтением (временный файл соседнего прогона,
    // атомарная запись через rename), роняет `add` кодом 128 «unable to index file» — журнал
    // 23–24.10 молчал так на 21 прогоне в грязном дереве. Снимок — момент времени: повтор
    // через миг видит дерево уже без него. Срок (status null) и 129 не повторяются.
    const add = (attr) => {
      for (let attempt = 1; ; attempt++) {
        try {
          return addOnce(attr);
        } catch (error) {
          if (
            attempt >= SNAPSHOT_TRIES ||
            typeof error?.status !== 'number' ||
            error.status === 129
          )
            throw Object.assign(error, { attempts: attempt });
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50 * attempt);
        }
      }
    };
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
    const keep = { keepStderr: true };
    const tree = git(repo.top, ['write-tree'], env, keep).trim();
    const rows = statRows(git(repo.top, ['ls-files', '--debug'], env, keep));
    return { tree, stat: statDigest(rows), rows };
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

const WIN = process.platform === 'win32';

/** Переменная по имени; на Windows имя без регистра (`Path` и `PATH` — одна). */
function envGet(env, name) {
  if (!WIN) return env[name];
  const k = Object.keys(env).find((n) => n.toUpperCase() === name);
  return k === undefined ? undefined : env[k];
}

/** NODE_OPTIONS на слова так же, как их делит node: кавычки группируют, `\` в кавычках экранирует. */
function splitNodeOptions(value) {
  const out = [];
  const s = String(value ?? '');
  let cur = '';
  let open = false;
  let quoted = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quoted && c === '\\' && i + 1 < s.length) {
      cur += s[++i];
      continue;
    }
    if (c === '"') {
      quoted = !quoted;
      open = true;
      continue;
    }
    if (!quoted && /\s/.test(c)) {
      if (open) out.push(cur);
      cur = '';
      open = false;
      continue;
    }
    cur += c;
    open = true;
  }
  if (open) out.push(cur);
  return out;
}

let ownEntries = null;
/** Свой вход: этот preload и, у установки панели, `bin/preload.cjs` с `bin/preload-locked.cjs`. */
function isOwnEntry(file, cwd) {
  if (!ownEntries) {
    const files = [path.join(__dirname, 'preload.cjs')];
    const bin = path.dirname(__dirname);
    if (path.basename(bin) === 'bin')
      files.push(path.join(bin, 'preload.cjs'), path.join(bin, 'preload-locked.cjs'));
    ownEntries = new Set(files.map(samePathKey));
  }
  return ownEntries.has(samePathKey(path.resolve(cwd, file)));
}

/**
 * Карта `local-overlay` для этого запуска — так же, как её ищет сам его preload (корень
 * реестра покрывает cwd или скрипт запуска). Нет карты — preload ничего не подменяет.
 */
function overlayMap(env, cwd) {
  let reg;
  try {
    const file =
      envGet(env, 'LOCAL_OVERLAY_REGISTRY') ||
      path.join(os.homedir(), '.claude', 'cache', 'local-overlay', 'registry.json');
    reg = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
  const norm = (p) => slash(realDir(p)).toLowerCase();
  const at = norm(cwd);
  const entry = process.argv[1] ? norm(process.argv[1]) : '';
  for (const [root, map] of Object.entries(reg?.roots ?? {})) {
    if (at === root || at.startsWith(`${root}/`) || entry.startsWith(`${root}/`)) return map;
  }
  return null;
}

/**
 * Обвязка машины в аргументах node (NODE_OPTIONS или execArgv) — не вход проверки, и
 * только она: свой вход журнала (иначе ключ зависел бы от версии журнала) и preload
 * `local-overlay`, пока он для этого запуска ничего не подменяет (одна сессия держала
 * его, группа сняла — тот же прогон на том же дереве давал другой ключ, журнал 19.10
 * 20:23). Прежде срезался любой `--require` со словом `verify-ledger` или `local-overlay`
 * в пути — и хук мутанта из каталога `verify-ledger-mutants` выпадал из ключа (24.10).
 * Действующий overlay остаётся, а его подмены уходят в `overlay`.
 */
function dropMachine(tokens, { env, cwd }) {
  const out = [];
  let overlay = null;
  for (let i = 0; i < tokens.length; i++) {
    const m = /^(?:--require|-r)(?:=(.*))?$/.exec(tokens[i]);
    const file = m ? (m[1] ?? tokens[i + 1]) : undefined;
    if (file !== undefined) {
      const isOverlay = /(?:^|[\\/])local-overlay[\\/]preload\.cjs$/i.test(file);
      const map = isOverlay ? overlayMap(env, cwd) : null;
      if (isOwnEntry(file, cwd) || (isOverlay && !map)) {
        if (m[1] === undefined) i++;
        continue;
      }
      if (map) {
        overlay = {
          preload: fileDigest(path.resolve(cwd, file)),
          map: sha(
            canonical(
              Object.keys(map)
                .sort()
                .map((k) => [k, map[k]?.hash ?? null, fileDigest(String(map[k]?.overlay))]),
            ),
          ),
        };
      }
    }
    out.push(tokens[i]);
  }
  return { tokens: out, overlay };
}

/** NODE_OPTIONS без обвязки машины — одной строкой. */
function stripPreload(value, { env = process.env, cwd = process.cwd() } = {}) {
  return dropMachine(splitNodeOptions(value), { env, cwd }).tokens.join(' ');
}

const pathMemo = new Map();
/**
 * Во что разрешаются `PATH_TOOLS` по PATH: на Windows — по каждому расширению PATHEXT и
 * без него (cmd ищет `npx.cmd`, bash — `npx`). Обёртка — по содержимому, большой файл —
 * по длинному пути, размеру и mtime.
 */
function pathPart(env) {
  const raw = String(envGet(env, 'PATH') ?? '');
  const exts = WIN
    ? [
        '',
        ...String(envGet(env, 'PATHEXT') || '.COM;.EXE;.BAT;.CMD')
          .split(';')
          .filter(Boolean)
          .map((e) => e.toLowerCase()),
      ]
    : [''];
  const memo = `${raw}\0${exts.join(';')}`;
  if (pathMemo.has(memo)) return pathMemo.get(memo);
  const want = new Set(PATH_TOOLS.flatMap((t) => exts.map((e) => `${t}${e}`)));
  const out = {};
  for (const dir of raw.split(path.delimiter)) {
    if (!dir || PM_SHIM_DIR.test(path.basename(dir))) continue;
    let names;
    try {
      names = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const n of names) {
      const k = WIN ? n.toLowerCase() : n;
      if (!want.has(k) || k in out) continue;
      const p = path.join(dir, n);
      let st;
      try {
        st = fs.statSync(p, { throwIfNoEntry: false });
      } catch {
        // Псевдоним запуска Windows (`WindowsApps\python3.exe`): stat — EACCES, а запускается он.
        out[k] = `a:${slash(p)}`;
        continue;
      }
      if (!st?.isFile()) continue;
      out[k] =
        st.size <= SHIM_CAP
          ? `c:${fileDigest(p)}`
          : `f:${slash(realDir(p))}|${st.size}|${Math.round(st.mtimeMs)}`;
    }
  }
  pathMemo.set(memo, out);
  return out;
}

/**
 * Значения — ключевым хешем (`key` журнала): в записи лежат части ключа, а простой sha
 * короткого пароля из окружения подбирается перебором.
 */
function envPart(env, extra, nodeOptions) {
  const mac = hmacKey();
  const digest = (v) => nodeCrypto.createHmac('sha256', mac).update(String(v)).digest('hex');
  const out = {};
  for (const [raw, v] of Object.entries(env)) {
    const k = WIN ? raw.toUpperCase() : raw;
    if (k === 'PATH') continue;
    const value = k === 'NODE_OPTIONS' ? nodeOptions : v;
    if (
      k !== 'NODE_OPTIONS' &&
      !(extra ?? []).includes(raw) &&
      ENV_SESSION.some((re) => re.test(k))
    )
      continue;
    if (value) out[k] = digest(value).slice(0, 24);
  }
  return out;
}

/**
 * Какие имена окружения разошлись с прошлым промахом той же проверки (`checkIdOf`): обвал
 * попаданий от новой сессионной переменной виден в ленте, а не только по счёту. Только имена —
 * значения в ленту не попадают.
 */
const envixFile = (repo, checkId) =>
  path.join(repo.store, `v${VERSION}`, 'envix', `${checkId}.json`);

function envDrift(repo, checkId, parts) {
  const now = {
    env: parts.env ?? {},
    path: parts.tool?.path ?? {},
    argv: parts.tool?.execArgv ?? [],
  };
  let prev = null;
  try {
    prev = JSON.parse(fs.readFileSync(envixFile(repo, checkId), 'utf8'));
  } catch {
    /* первый прогон проверки */
  }
  try {
    fs.mkdirSync(path.dirname(envixFile(repo, checkId)), { recursive: true });
    writeAtomic(envixFile(repo, checkId), JSON.stringify(now));
  } catch {
    /* без индекса — без подсказки */
  }
  if (!prev) return null;
  const diff = (a = {}, b = {}, prefix = '') =>
    [...new Set([...Object.keys(a), ...Object.keys(b)])]
      .filter((k) => a[k] !== b[k])
      .map((k) => `${prefix}${k}`);
  const names = [
    ...diff(prev.env, now.env),
    ...diff(prev.path, now.path, 'PATH:'),
    ...(canonical(prev.argv) === canonical(now.argv) ? [] : ['execArgv']),
  ].sort();
  return names.length ? names.slice(0, 20).join(',') : null;
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
/**
 * Каталоги, которые видит проверка (`scopeTree`), или `null` — всё дерево.
 * Корень (его файлы) в области всегда.
 */
function scopeDirs(repo, cwd, match) {
  if (match.entry || match.id === 'vitest') return null;
  const top = realDir(repo.top);
  const pkgAbs = realDir(cwd);
  const pkgRel = slash(path.relative(top, pkgAbs));
  if (!pkgRel || pkgRel.startsWith('..') || !fs.existsSync(path.join(pkgAbs, 'package.json')))
    return null;
  const dirs = new Set([pkgRel, ...require('./delta.cjs').linkedDirs(top, pkgAbs)]);
  for (const name of fs.readdirSync(pkgAbs)) {
    if (!SCOPE_CONFIG.test(name)) continue;
    let text;
    try {
      text = fs.readFileSync(path.join(pkgAbs, name), 'utf8');
    } catch {
      return null;
    }
    for (const m of text.matchAll(/['"`](\.\.\/[^'"`*]*)/g)) {
      const rel = slash(path.relative(top, path.resolve(pkgAbs, m[1])));
      if (rel.startsWith('..')) return null;
      // Каталог верхнего уровня целиком — грубо, зато без догадок о вложенности;
      // файл корня (`../tsconfig.base.json`) и так в ключе.
      const first = rel.split('/')[0];
      if (!rel) return null;
      if (fs.statSync(path.join(top, first), { throwIfNoEntry: false })?.isDirectory())
        dirs.add(first);
    }
  }
  return [...dirs].sort();
}

function scopeTree(repo, tree, cwd, match) {
  if (!tree) return tree;
  const dirs = scopeDirs(repo, cwd, match);
  if (!dirs) return tree;
  const top = realDir(repo.top);
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
  const opts = dropMachine(splitNodeOptions(envGet(env, 'NODE_OPTIONS')), { env, cwd });
  const argv = dropMachine(execArgv, { env, cwd });
  const overlay = opts.overlay ?? argv.overlay;
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
      execArgv: argv.tokens,
      path: pathPart(env),
      ...(overlay ? { overlay } : {}),
    },
    env: envPart(env, entry?.env, opts.tokens.join(' ')),
    script,
  };
}

const keyOf = (parts) => sha(canonical(parts));

/**
 * Дерево сменилось за время прогона, но не там, что проверка видит: прогон годен для
 * своего ключа. Только для проверки с узкой областью (`scopeDirs`: tsc, eslint,
 * prettier, vite в пакете монорепо) — область та же, по чему ключ и так судит, что
 * проверке не изменилось ничего. Нужны оба условия: ключ, посчитанный по дереву КОНЦА,
 * равен ключу начала (содержимое области, `.env*`, lock-файлы, скрипт), и в области не
 * сдвинулись mtime/size (правка с откатом посреди прогона). vitest — нет: тест исполняет
 * что угодно по пути из своего кода, его область — всё дерево, и правку соседа он мог прочесть.
 */
function inputsSteady({ repo, match, cwd, start, end, key, env = process.env }) {
  if (!end || end.off || !end.tree || !start?.rows || !end.rows) return false;
  const dirs = scopeDirs(repo, realDir(cwd), match);
  if (!dirs) return false;
  const inScope = (p) => !p.includes('/') || dirs.some((d) => p === d || p.startsWith(`${d}/`));
  if (statDigest(start.rows, inScope) !== statDigest(end.rows, inScope)) return false;
  return keyOf(keyParts({ repo, match, cwd, tree: end.tree, env })) === key;
}

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
  if (!keyFresh(repo, all, now)) return { hit: null, reason: 'stale' };
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

/** Время прогона из его id (`<Date.now() в base36>-pid-rand`): без чтения записи. */
function runTime(runId) {
  const t = parseInt(String(runId).split('-')[0], 36);
  return Number.isFinite(t) ? t : 0;
}

function storeCap(env = process.env) {
  const mb = Number(env.AGENTDECK_VERIFY_LEDGER_CAP_MB);
  return mb > 0 ? Math.floor(mb * 1024 * 1024) : STORE_CAP;
}

const listDir = (dir) => {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
};

/** Байты каталога целиком (артефакты прогона). */
function treeBytes(dir) {
  let total = 0;
  for (const e of listDir(dir)) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) total += treeBytes(p);
    else total += fs.statSync(p, { throwIfNoEntry: false })?.size ?? 0;
  }
  return total;
}

/**
 * Уборка хранилища. Ключ уходит, когда постарел (`keyFresh`: срок от последнего
 * использования и ни одной живой работы) или когда панель убрала копию, и только
 * она касалась ключа (`removed`). Затем — сироты (вывод и артефакты без записи,
 * старше `PRUNE_GRACE_MS`), временные индексы упавших процессов, старые метки
 * нестабильности и, сверх предела, ключи, дольше всех не использованные.
 * Запись ключа удаляется раньше его вывода: читатель увидит «записи нет», а не
 * запись без вывода. `dry` — только посчитать.
 */
function prune(repo, { now = Date.now(), removed = [], cap = storeCap(), dry = false } = {}) {
  const root = path.join(repo.store, `v${VERSION}`);
  const removedSet = new Set(removed.map(samePathKey));
  const keys = new Map();
  const runBytes = new Map();
  const rm = (p) => {
    if (!dry) fs.rmSync(p, { recursive: true, force: true });
  };
  for (const d of listDir(path.join(root, 'runs'))) {
    if (!d.isDirectory()) continue;
    const dir = path.join(root, 'runs', d.name);
    for (const e of listDir(dir)) {
      const m = /^([0-9a-f]{64})\.(.+)\.json$/.exec(e.name);
      if (!m) continue;
      const file = path.join(dir, e.name);
      const size = fs.statSync(file, { throwIfNoEntry: false })?.size ?? 0;
      const at = runTime(m[2]);
      const k = keys.get(m[1]) ?? { files: [], lastUse: 0, bytes: 0 };
      k.files.push({ file, runId: m[2], at, size });
      k.lastUse = Math.max(k.lastUse, at);
      k.bytes += size;
      keys.set(m[1], k);
    }
  }
  const outs = [];
  for (const e of listDir(path.join(root, 'out'))) {
    const m = /^(.+)\.(stdout|stderr)\.gz$/.exec(e.name);
    if (!m) continue;
    const file = path.join(root, 'out', e.name);
    const size = fs.statSync(file, { throwIfNoEntry: false })?.size ?? 0;
    runBytes.set(m[1], (runBytes.get(m[1]) ?? 0) + size);
    outs.push({ file, runId: m[1] });
  }
  const arts = [];
  for (const e of listDir(path.join(root, 'art'))) {
    if (!e.isDirectory()) continue;
    const dir = path.join(root, 'art', e.name);
    runBytes.set(e.name, (runBytes.get(e.name) ?? 0) + treeBytes(dir));
    arts.push({ file: dir, runId: e.name });
  }
  const bytesOf = (k) => k.files.reduce((s, f) => s + f.size + (runBytes.get(f.runId) ?? 0), 0);
  let before = 0;
  for (const k of keys.values()) before += bytesOf(k);

  const cache = new Map();
  const drop = { dead: 0, lru: 0, orphans: 0, tmp: 0, flaky: 0 };
  const gone = new Set();
  const dropKey = (key) => {
    for (const f of keys.get(key).files) rm(f.file);
    for (const f of keys.get(key).files) gone.add(f.runId);
    keys.delete(key);
  };
  for (const [key, k] of keys) {
    // Свежий ключ без уборки копии — не читать: таких тысячи, решает одно имя файла.
    if (!removedSet.size && now - k.lastUse <= TTL_MS) continue;
    const all = k.files.map((f) => {
      try {
        const r = JSON.parse(fs.readFileSync(f.file, 'utf8'));
        return { startedAt: Number(r.startedAt) || f.at, wt: r.wt };
      } catch {
        return { startedAt: f.at, wt: null };
      }
    });
    if (!keyFresh(repo, all, now, { removed: removedSet, cache })) {
      dropKey(key);
      drop.dead += 1;
    }
  }
  let after = 0;
  for (const k of keys.values()) after += bytesOf(k);
  if (after > cap) {
    const order = [...keys].sort((a, b) => a[1].lastUse - b[1].lastUse);
    for (const [key, k] of order) {
      if (after <= cap * 0.75) break;
      if (now - k.lastUse <= PRUNE_GRACE_MS) continue;
      after -= bytesOf(k);
      dropKey(key);
      drop.lru += 1;
    }
  }
  const owned = new Set();
  for (const k of keys.values()) for (const f of k.files) owned.add(f.runId);
  for (const item of [...outs, ...arts]) {
    if (owned.has(item.runId)) continue;
    if (!gone.has(item.runId) && now - runTime(item.runId) <= PRUNE_GRACE_MS) continue;
    rm(item.file);
    if (!gone.has(item.runId)) drop.orphans += 1;
  }
  for (const e of listDir(path.join(repo.store, 'tmp'))) {
    const p = path.join(repo.store, 'tmp', e.name);
    const st = fs.statSync(p, { throwIfNoEntry: false });
    if (st && now - st.mtimeMs > 3600e3) {
      rm(p);
      drop.tmp += 1;
    }
  }
  for (const e of listDir(path.join(root, 'flaky'))) {
    const p = path.join(root, 'flaky', e.name);
    const st = fs.statSync(p, { throwIfNoEntry: false });
    if (st && now - st.mtimeMs > FLAKY_MS) {
      rm(p);
      drop.flaky += 1;
    }
  }
  // Индекс подсказки `env-changed`: проверка, не бывшая дольше срока записи, подсказки не ждёт.
  for (const e of listDir(path.join(root, 'envix'))) {
    const p = path.join(root, 'envix', e.name);
    const st = fs.statSync(p, { throwIfNoEntry: false });
    if (st && now - st.mtimeMs > TTL_MS) rm(p);
  }
  return { keys: keys.size, drop, bytes: { before, after }, cap, dry };
}

/**
 * Уборка из preload, не чаще `PRUNE_EVERY_MS` на хранилище: метка `prune.json` ставится
 * ДО обхода, и соседний процесс того же часа уборку не повторяет.
 */
function maybePrune(repo, now = Date.now()) {
  try {
    const stamp = path.join(repo.store, 'prune.json');
    const st = fs.statSync(stamp, { throwIfNoEntry: false });
    if (st && now - st.mtimeMs < PRUNE_EVERY_MS) return null;
    writeAtomic(stamp, JSON.stringify({ at: now, pid: process.pid }));
    const result = prune(repo, { now });
    writeAtomic(stamp, JSON.stringify({ at: now, ...result }));
    return result;
  } catch {
    return null;
  }
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
  STORE_CAP,
  homeDir,
  workOf,
  workAlive,
  keyFresh,
  prune,
  maybePrune,
  locked,
  modeOf,
  repoOf,
  snapshot,
  stderrTail,
  keyParts,
  keyOf,
  inputsSteady,
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
  envDrift,
  canonical,
  verify,
};
