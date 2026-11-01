/**
 * Одноразовый стенд для проверок, которые ПИШУТ: своя панель и свой фронт над
 * временным домом. Рабочий стенд человека (:5178/:8888, настоящий `~/.claude`,
 * реестр проектов, транскрипты) такой проверкой не затрагивается вовсе.
 *
 * Почему отдельный модуль. Проверка, привязанная к кейсу раздела «Тесты»,
 * запускается без присмотра, поэтому писать в настоящую конфигурацию ей нельзя
 * (AGENTS.md, «Tests block»). Каждая такая проверка поднимала бы одно и то же:
 * временный HOME/USERPROFILE/CLAUDE_CONFIG_DIR/APPDATA, PATH без настоящего
 * `claude`, панель и Vite на свободных портах, снятие деревом. Двадцать копий
 * этой обвязки разъехались бы первой же правкой — здесь она одна.
 *
 * Что подменено: только дом процесса и PATH; переменные дома чужих CLI из
 * оболочки человека (`XDG_*`, `CODEX_HOME`, `GOOSE_*`…) отрезаны, свои проверка
 * кладёт сама или передаёт `env`. Панель — настоящий
 * `apps/server/src/index.ts`, фронт — настоящий Vite из `apps/web`, запросы
 * идут через его прокси так же, как у человека.
 *
 * Использование:
 *   const stand = await startStand({ seed: ({ cfg, home }) => ... });
 *   try { ... stand.api('/rules') ... stand.newPage(browser) ... }
 *   finally { await stand.stop(); }
 */
import { spawn, spawnSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HOP_RECORD_ENV, listenerPid, watchHops } from '../../apps/server/src/lib/hop-recorder.mjs';
import { brandEnvName, legacyEnvName } from '../../apps/server/src/lib/brand.mjs';
import {
  filetimeFromMs,
  killLeftovers,
  killProcessTree,
  readPosixProcessTable,
  readProcessTable,
  WATCH_SLACK_MS,
} from '../../apps/server/src/lib/kill-tree.mjs';

// Префиксы переменных панели — нынешний и прежний. Прежний собирает brand.mjs
// из частей: литерал старого имени в дереве запрещён (`pnpm brand`).
const PANEL_ENV_PREFIXES = [brandEnvName(''), legacyEnvName('')];

export const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const IS_WIN = process.platform === 'win32';

/**
 * Окружение, с которым процесс проверки пришёл из оболочки человека. Снято при
 * загрузке модуля: статические импорты исполняются раньше кода проверки, так что
 * всё, что проверка потом кладёт в `process.env` сама, сюда не попадает.
 */
const SHELL_ENV = { ...process.env };
/** Настоящий дом человека — до того, как кто-либо в процессе тронул HOME. */
export const REAL_HOME = homedir();

// Переменные, которыми чужой CLI находит свой дом и конфиг. Пришедшая из оболочки
// направила бы настоящий CLI на стенде в настоящий дом человека: подмена
// HOME/APPDATA её не перекрывает. Имена — `.agent/universal-providers.agent.md`
// (документированные переопределения) и `--help` самих CLI.
const PROVIDER_ENV_PREFIXES = [
  'XDG_',
  'GOOSE_',
  'OPENCODE_CONFIG',
  'GEMINI_CLI_',
  'KIMI_',
  'QWEN_CODE_',
];
const PROVIDER_ENV_NAMES = [
  'CODEX_HOME',
  'QWEN_HOME',
  'KIMI_CODE_HOME',
  'GEMINI_CLI_HOME',
  'CONTINUE_GLOBAL_DIR',
];

/** Переменная дома/конфига чужого CLI (без учёта регистра — Windows). */
export function isProviderEnvKey(key) {
  const upper = key.toUpperCase();
  return (
    PROVIDER_ENV_NAMES.includes(upper) ||
    PROVIDER_ENV_PREFIXES.some((prefix) => upper.startsWith(prefix))
  );
}

/**
 * Переменная пришла из оболочки, и проверка её не переставляла — в стенд она не
 * идёт. Проверка, задавшая свою (`process.env.CODEX_HOME = tmp` до `startStand`,
 * как делают `check-foreign-steer` и соседи), своё значение сохраняет: оно уже не
 * равно снятому из оболочки.
 */
function shellLeak(key, value) {
  return isProviderEnvKey(key) && SHELL_ENV[key] === value;
}

/**
 * Настоящие каталоги CLI человека, которые проверка обязана оставить как были.
 * Только список путей: ни один не создаётся и не пишется.
 */
export function realProviderDirs(home = REAL_HOME) {
  let top = [];
  try {
    top = readdirSync(home);
  } catch {
    // дом не читается — проверять нечего, кроме фиксированных имён
  }
  const named = top.filter((name) => name.startsWith('.claude') || name.startsWith('.aider'));
  const fixed = [
    '.codex',
    '.qwen',
    '.gemini',
    join('.config', 'goose'),
    join('.config', 'opencode'),
    '.kimi',
    '.continue',
    '.agents',
  ];
  const dirs = [...new Set([...named, ...fixed])].map((rel) => join(home, rel));
  // Goose на Windows держит конфиг в %APPDATA%\Block\goose, а не в ~/.config.
  if (IS_WIN && SHELL_ENV.APPDATA) dirs.push(join(SHELL_ENV.APPDATA, 'Block', 'goose'));
  return dirs;
}

/**
 * Что живая сессия Claude Code человека пишет сама, пока идёт проверка, — без
 * этого исключения любая проверка на машине с открытым чатом краснела бы.
 * Пути — с прямыми слэшами, от дома.
 */
export const LIVE_SESSION_CHURN = [
  /\/\.claude\.json(\.[^/]*)?$/,
  /\/\.claude\/(history\.jsonl|backups|cache|sessions|projects|todos|shell-snapshots|statsig|session-env|file-history|debug|ide|plans|paste-cache|telemetry)(\/|$)/,
  // Рабочая панель человека (:5178) пишет своё состояние, пока идёт проверка.
  // Стенд в него не пишет: его каталог Claude и состояние — во временном доме.
  /\/\.claude\/agentdeck(\/(state\.json|server\.log))?$/,
  // `~/.claude` человека может быть git-репозиторием, куда коммитят его же
  // сессии; живая сессия Codex держит свои `tmp/arg0`. Ни один проверяемый CLI
  // туда не пишет (их каталоги — во временном доме), а прогон 28.10 краснел на них.
  /\/\.claude\/\.git(\/|$)/,
  /\/\.codex\/tmp(\/|$)/,
  // Уборка и автообновление маркетплейсов, которые Claude Code делает при каждом
  // запуске. Стенд `claude` не запускает (его нет в PATH стенда).
  /\/\.claude\/\.last-cleanup$/,
  /\/\.claude\/plugins(\/(cache|marketplaces|known_marketplaces\.json)(\/|$)|$)/,
  // Политики и удалённые настройки, которые идущий сеанс Claude Code обновляет
  // сам примерно раз в четверть часа (живой прогон Goose 09.10: 15 минут — и
  // проверка покраснела на них). Запись идёт через переименование, поэтому
  // меняется и mtime самого каталога; новый файл в нём всё равно виден строкой.
  /\/\.claude\/(policy-limits\.json(\.stamp\.json)?|remote-settings\.json)$/,
  /\/\.claude$/,
];

/**
 * Снимок mtime/размера настоящих каталогов CLI человека: сам каталог и записи до
 * глубины `depth`. ТОЛЬКО `lstat`/`readdir` — ничего не создаётся и не пишется,
 * ссылки не разыменовываются. Сравнить — `diffRealProviderDirs(before, after)`.
 */
export function snapshotRealProviderDirs({ dirs = realProviderDirs(), depth = 2 } = {}) {
  const entries = {};
  const visit = (path, level) => {
    let stat;
    try {
      stat = lstatSync(path);
    } catch (error) {
      entries[path] = error?.code === 'ENOENT' ? 'absent' : `unreadable:${error?.code}`;
      return;
    }
    entries[path] = `${stat.mtimeMs}:${stat.size}`;
    if (level >= depth || !stat.isDirectory()) return;
    let names;
    try {
      names = readdirSync(path);
    } catch {
      return;
    }
    for (const name of names) visit(join(path, name), level + 1);
  };
  for (const dir of dirs) visit(dir, 0);
  return { at: Date.now(), entries };
}

/**
 * Записи, что изменились, появились или пропали между двумя снимками. `ignore` —
 * регулярки по пути с прямыми слэшами; по умолчанию — шум живой сессии Claude.
 */
export function diffRealProviderDirs(before, after, { ignore = LIVE_SESSION_CHURN } = {}) {
  const paths = new Set([...Object.keys(before.entries), ...Object.keys(after.entries)]);
  return [...paths]
    .filter((path) => (before.entries[path] ?? 'absent') !== (after.entries[path] ?? 'absent'))
    .filter((path) => !ignore.some((pattern) => pattern.test(path.replaceAll('\\', '/'))))
    .map((path) => ({
      path,
      before: before.entries[path] ?? 'absent',
      after: after.entries[path] ?? 'absent',
    }));
}

export class NotChecked extends Error {}

/**
 * Место необработанного исключения, если процесс Node упал на файле проекта:
 * заголовок `file:///…:N` перед строкой кода. Внутренности Node (`node:…`, занятый
 * порт) и зависимости (`node_modules`) — окружение, не код: undefined.
 */
export function codeCrash(log) {
  const header = /^(file:\/\/\/\S+?):(\d+)\r?$/m.exec(log);
  if (!header) return undefined;
  const file = decodeURIComponent(header[1]);
  return /[\\/]node_modules[\\/]/.test(file) ? undefined : `${file}:${header[2]}`;
}

export const wait = (ms) => new Promise((done) => setTimeout(done, ms));

/** Свободный порт у системы: фиксированный номер свёл бы прогон с брошенной панелью прошлого. */
export function freePort() {
  return new Promise((done, fail) => {
    const probe = createServer();
    probe.on('error', fail);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => done(port));
    });
  });
}

async function waitFor(url, seconds, gone = () => false) {
  for (let i = 0; i < seconds * 4; i += 1) {
    try {
      const res = await fetch(url);
      if (res.ok) return true;
    } catch {
      // ещё не поднялся
    }
    // Процесс уже вышел — ждать минуту нечего (проверка поломкой ждала её на каждом скрипте).
    if (gone()) return false;
    await wait(250);
  }
  return false;
}

/**
 * PATH без `claude`: одноразовая панель не должна запускать настоящий CLI (он
 * пошёл бы в сеть и в учётную запись человека). Git и node остаются — без git не
 * работают проекты. Исключение — каталоги, поставленные самой проверкой
 * (`checkAddedPathDirs`); если в таком лежит `claude`, `keptClaude` велит стенду
 * заслонить его заглушкой (`BLOCKED_CLAUDE`).
 *
 * Windows: каталог с `claude` (или с CLI из `hideCli`) вырезается целиком —
 * `%APPDATA%\npm` держит одни обёртки npm. POSIX: `npm i -g` кладёт `claude`
 * рядом с node, npx и pnpm (nvm, `/usr/local/bin`), Homebrew — рядом с git и go;
 * вырезанный каталог оставлял панель без них. Там каталог заменяется копией из
 * ссылок на всё, кроме скрытых имён (`mirrorRoot/<n>`).
 */
export function pathWithoutClaude(hideCli = [], mirrorRoot) {
  const raw = process.env.PATH ?? process.env.Path ?? '';
  const filesOf = (cli) =>
    IS_WIN ? ['cmd', 'exe', 'ps1', ''].map((ext) => (ext ? `${cli}.${ext}` : cli)) : [cli];
  const names = filesOf('claude');
  const hidden = hideCli.flatMap(filesOf);
  const added = new Set(checkAddedPathDirs(raw));
  let keptClaude = false;
  let mirrors = 0;
  const dirs = raw.split(delimiter).flatMap((dir) => {
    if (!dir) return [];
    const present = (list) => list.filter((name) => existsSync(join(dir, name)));
    const hiddenHere = present(hidden);
    const claudeHere = present(names);
    const keep = claudeHere.length > 0 && added.has(dir);
    if (IS_WIN) {
      if (hiddenHere.length > 0) return [];
      if (keep) keptClaude = true;
      return claudeHere.length === 0 || keep ? [dir] : [];
    }
    if (keep) keptClaude = true;
    const skip = keep ? hiddenHere : [...hiddenHere, ...claudeHere];
    if (skip.length === 0) return [dir];
    mirrors += 1;
    const mirror = mirrorDir(dir, skip, join(mirrorRoot, String(mirrors)));
    return mirror ? [mirror] : [];
  });
  return { path: dirs.join(delimiter), keptClaude };
}

/**
 * Каталог `target` из ссылок на каждую запись `dir`, кроме `skip`. Ссылка — на
 * путь записи, не на её настоящий путь: относительные ссылки npm и Homebrew
 * (`../lib/node_modules/…`, `../Cellar/…`) разрешаются от своего каталога.
 * Каталог не читается — `undefined`, вызывающий его вырезает.
 */
export function mirrorDir(dir, skip, target) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return undefined;
  }
  mkdirSync(target, { recursive: true });
  for (const entry of entries) {
    if (skip.includes(entry)) continue;
    try {
      symlinkSync(join(dir, entry), join(target, entry));
    } catch {
      // Запись исчезла между чтением и ссылкой — без неё каталог всё равно годен.
    }
  }
  return target;
}

/**
 * Заглушка `claude` на случай, когда каталог проверки несёт и настоящий: такой
 * каталог оставлен ради соседа (npm кладёт opencode рядом с claude.cmd), а сам
 * Claude в одноразовом стенде запускаться не должен — отказ громкий, не тихий.
 */
const BLOCKED_CLAUDE = `process.stderr.write('throwaway-stand: настоящий claude в одноразовом стенде запрещён\\n');
process.exit(1);
`;

/**
 * Каталоги, которые проверка САМА поставила в PATH до `startStand` (каталог
 * найденного CLI перед PATH оболочки). Их вырезать нельзя, даже если там лежит
 * `claude`: npm кладёт opencode, codex и прочих рядом с claude.cmd, и стенд,
 * вырезав каталог, прятал от панели тот самый CLI, ради которого шла проверка, —
 * панель отвечала «нужен вход в CLI» (группа foreign-steer, 10.10).
 */
function checkAddedPathDirs(raw) {
  const shell = SHELL_ENV.PATH ?? SHELL_ENV.Path ?? '';
  if (!shell || raw === shell) return [];
  if (raw.endsWith(shell)) return raw.slice(0, raw.length - shell.length).split(delimiter);
  const known = new Set(shell.split(delimiter));
  return raw.split(delimiter).filter((dir) => dir && !known.has(dir));
}

/**
 * Снять ровно тот процесс, который стенд запустил сам, — и только его.
 *
 * Без `taskkill /T`: дерево Windows строит по записанному PID родителя, а его
 * не стирают, когда родитель умер. Процесс человека, чей родитель давно
 * закрыт (сторож keepalive, запущенный из закрытого терминала), числится
 * «потомком» любого нового процесса, получившего тот же освободившийся PID, —
 * и `/T` снёс бы живой стенд человека. Оба наших процесса запущены напрямую
 * через node, без оболочки, поэтому их PID — сами сервер и Vite. Их потомки
 * (esbuild у Vite, MCP-процессы проверки у сервера) держатся за stdin-трубу
 * родителя и завершаются, когда она закрывается.
 */
/**
 * Маршрут-заглушка ядра стенда по умолчанию: один ответ текстом (`packages/stub-model`, шаг
 * `text`). Свой сценарий — `startStand({ core: { stub: [...] } })`.
 */
export const DEFAULT_CORE_STUBS = [{ name: 'stand', script: ['stub reply'] }];

/** Имя метки жизни стенда рядом с фальшивыми CLI (`fake-cli-images.mjs` её ждёт). */
export const STAND_ALIVE = '.stand-alive';

function killTree(child) {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
  // На Windows `kill()` — TerminateProcess одной панели: её `exit`-обработчики
  // (снятие `opencode serve` и прочих серверов CLI) не исполняются, а дети
  // `cmd → opencode.exe` переживают стенд и держат его временный дом (EPERM при
  // удалении). Снимаем дерево целиком, пока родители живы и связь видна.
  if (IS_WIN) {
    const result = spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    if (result.status === 0) return;
  }
  child.kill(IS_WIN ? undefined : 'SIGTERM');
}

/**
 * Снять посредников живых сессий (`live-relay.mjs`), которых запустила панель
 * стенда. Посредник нарочно отвязан от панели — сессия переживает её
 * перезапуск, а сам он гаснет после получаса простоя. Одноразовый стенд второй
 * раз не стартует: ход настоящего CLI (не фальшивого, тот умирает по метке
 * жизни) оставлял посредника с `claude.exe` под ним, и они держали временный
 * дом (EPERM при удалении). Pid берётся из журнала прогонов панели и снимается,
 * только если это всё ещё посредник: освободившийся pid мог достаться чужому.
 */
export function reapStandRelays(stateDir) {
  let entries;
  try {
    entries = JSON.parse(readFileSync(join(stateDir, 'runs.json'), 'utf8'));
  } catch {
    return;
  }
  const pids = [
    ...new Set(
      (Array.isArray(entries) ? entries : [])
        .map((entry) => entry?.relay?.pid)
        .filter((pid) => Number.isInteger(pid)),
    ),
  ];
  for (const pid of pids) {
    if (!IS_WIN) {
      // `ps`, не `/proc`: на macOS его нет, и посредник с CLI под ним жил после
      // стенда до получаса. Деревом — CLI под посредником уходит вместе с ним.
      const probe = spawnSync('ps', ['-o', 'args=', '-p', String(pid)], { encoding: 'utf8' });
      if (probe.stdout?.includes('live-relay.mjs')) killProcessTree(pid);
      continue;
    }
    const probe = spawnSync(
      'powershell',
      [
        '-NoProfile',
        '-Command',
        `(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}').CommandLine`,
      ],
      { encoding: 'utf8', windowsHide: true },
    );
    if (!probe.stdout?.includes('live-relay.mjs')) continue;
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    });
  }
}

const readJsonQuiet = (path) => {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return undefined;
  }
};

const listQuiet = (dir) => {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
};

/**
 * Личности хостов сессий ядра стенда и их CLI — по записям самого ядра, не по имени процесса:
 * `host.json` каждой сессии (`tasks/<задача>/sessions/<сессия>/`, хост пишет его сам, как только
 * поднял CLI) и строки `session.started` журналов задач (`hostPid`/`hostStart`, `cliPid`/`cliStart`).
 * Обе записи нужны: ядро, убитое между запуском хоста и строкой журнала, оставляет только
 * `host.json`, а сессия с каталогом вне `sessions/` — только строку журнала.
 */
export function coreSessionIdentities(coreHome) {
  const found = new Map();
  const add = (pid, start, role) => {
    if (!Number.isInteger(pid) || pid <= 0 || typeof start !== 'string' || !start) return;
    found.set(`${pid}:${start}`, { pid, start, role });
  };
  const tasks = join(coreHome, 'tasks');
  for (const task of listQuiet(tasks)) {
    const dir = join(tasks, task);
    for (const session of listQuiet(join(dir, 'sessions'))) {
      const record = readJsonQuiet(join(dir, 'sessions', session, 'host.json'));
      add(record?.host?.pid, record?.host?.start, 'host');
      add(record?.child?.pid, record?.child?.start, 'cli');
    }
    let text;
    try {
      text = readFileSync(join(dir, 'journal.jsonl'), 'utf8');
    } catch {
      continue;
    }
    for (const raw of text.split('\n')) {
      if (!raw.includes('"session.started"')) continue;
      let line;
      try {
        line = JSON.parse(raw);
      } catch {
        continue;
      }
      if (line?.kind !== 'session.started') continue;
      add(line.data?.hostPid, line.data?.hostStart, 'host');
      add(line.data?.cliPid, line.data?.cliStart, 'cli');
    }
  }
  return [...found.values()];
}

/** Часы Linux для разбора старта: номер загрузки и её момент. Нет `/proc` — `undefined`. */
function linuxClock() {
  try {
    const bootId = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
    const btime = /^btime (\d+)$/m.exec(readFileSync('/proc/stat', 'utf8'))?.[1];
    return btime ? { bootId, btimeMs: Number(btime) * 1000 } : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Старт процесса из записи ядра (`platform/process-table.ts`) → время создания в тиках FILETIME
 * снимка `kill-tree.mjs`. Windows: ядро пишет то же число, сверка точная. Linux:
 * `<boot_id>:<тики с загрузки>` (другая загрузка — процесса уже нет: `null`). macOS:
 * `<секунды>:<хеш имени>`. Не разобрать — `undefined`: личность не доказать, снимать нельзя.
 */
export function createdOfStart(start, platform = process.platform, clock = linuxClock) {
  if (platform === 'win32') return /^\d+$/.test(start) ? BigInt(start) : undefined;
  if (platform === 'darwin') {
    const seconds = /^(\d+):/.exec(start)?.[1];
    return seconds ? filetimeFromMs(Number(seconds) * 1000) : undefined;
  }
  const match = /^([^:]+):(\d+)$/.exec(start);
  const now = match ? clock() : undefined;
  if (!match || !now) return undefined;
  if (now.bootId !== match[1]) return null;
  // Тики `/proc/<pid>/stat` — сотые доли секунды (USER_HZ = 100, как у ядра задач).
  return filetimeFromMs(now.btimeMs + Number(match[2]) * 10);
}

/**
 * Снять хосты сессий ядра стенда вместе с их CLI (и потомками). Хост запускается отвязанным
 * (на Windows — вырывом из задания через WMI): ни снятие дерева панели и ядра, ни уход процесса
 * проверки его не уносят, и хост с `claude.exe` под ним жил после стенда, держа его каталог (EBUSY
 * при удалении, проход s9). Снимается только процесс, чьё время создания совпало с записанным
 * стартом (Windows — точно, POSIX — с запасом `WATCH_SLACK_MS`), и по дескриптору со сверкой
 * (`killLeftovers`): освободившийся номер мог достаться чужому. Синхронно — зовётся и из `exit`.
 * Итог: `ids` — найденные личности, `stopped` — номера, по которым ушёл сигнал, `unprovable` —
 * записи, чей старт не разобрать.
 */
export function reapCoreSessions(coreHome, impl = {}) {
  const platform = impl.platform ?? process.platform;
  const ids = coreSessionIdentities(coreHome);
  const unprovable = [];
  // Один номер мог принадлежать двум процессам в разное время (перезапуск хоста): у каждой
  // пачки номер встречается раз — карта `pid → время` иначе потеряла бы одну из личностей.
  const batches = [];
  for (const id of ids) {
    const created = createdOfStart(id.start, platform, impl.clock);
    if (created === null) continue;
    if (created === undefined) {
      unprovable.push(id);
      continue;
    }
    let batch = batches.find((map) => !map.has(id.pid));
    if (!batch) batches.push((batch = new Map()));
    batch.set(id.pid, created);
  }
  const slackMs = platform === 'win32' ? 0 : WATCH_SLACK_MS;
  const stopped = batches.flatMap((batch) => killLeftovers(batch, { slackMs }, impl));
  return { ids, stopped, unprovable };
}

/**
 * Кто из `ids` всё ещё жив той же личностью (снимок после снятия). Снимка нет — живыми
 * считаются все: доказать обратное нечем, и отчёт об этом честнее тишины.
 */
export function liveCoreSessions(ids, impl = {}) {
  if (ids.length === 0) return [];
  const platform = impl.platform ?? process.platform;
  const readTable =
    impl.readTable ?? (platform === 'win32' ? readProcessTable : readPosixProcessTable);
  const table = readTable();
  if (!table) return ids.map((id) => ({ ...id, why: 'снимка процессов нет' }));
  const slack = BigInt(platform === 'win32' ? 0 : WATCH_SLACK_MS) * 10_000n;
  const byPid = new Map(table.map((row) => [row.pid, row]));
  const left = [];
  for (const id of ids) {
    const row = byPid.get(id.pid);
    const created = createdOfStart(id.start, platform, impl.clock);
    if (!row || created === null) continue;
    if (created === undefined) {
      left.push({ ...id, why: 'старт не разобрать — личность не доказать' });
      continue;
    }
    const gap = row.created > created ? row.created - created : created - row.created;
    if (gap <= slack) left.push({ ...id, why: 'жив после снятия' });
  }
  return left;
}

/**
 * Поднять одноразовый стенд.
 *
 * `settings` — поля `state.json → settings` до старта (мастер онбординга выключен
 * настоящей настройкой, а не перехватом ответа: проверка видит то, что видит
 * человек, прошедший мастер). `seed` получает пути и раскладывает файлы до
 * запуска сервера. `web: false` — только API. `serverDir` — каталог сервера
 * (по умолчанию `apps/server` репозитория): прогон «до правки» поднимает копию
 * прежнего сервера, не трогая файлы, на которых живёт стенд человека.
 */
export async function startStand({
  seed,
  settings = {},
  web = true,
  label = 'stand',
  fakeCli = {},
  serverDir = join(REPO, 'apps/server'),
  // Машина без Claude Code: ни `~/.claude`, ни CLAUDE_CONFIG_DIR; состояние
  // панели — в `~/.agentdeck/data` (так его ищет сама панель без каталога Claude).
  noClaude = false,
  // Каталоги в КОНЕЦ PATH панели (настоящий CLI другого провайдера).
  extraPath = [],
  // CLI, которых в PATH оболочки для стенда быть не должно (`['goose']`): каталоги
  // с ними вырезаются целиком, как каталоги `claude`. Сценарий «CLI нет» иначе
  // зависит от того, что человек поставил себе: `~/.local/bin` с goose.exe и
  // aider.exe (09.10) превратил «нет aider» в «aider найден», а обёртку-без-acp
  // перекрыл настоящий goose.exe — панель ищет .exe по всему PATH раньше .cmd.
  // `extraPath` не трогается: его кладёт сама проверка.
  hideCli = [],
  // Окружение панели сверх унаследованного (дом и конфиг чужого CLI, ключ
  // заглушки). Явное — поэтому чистка `shellLeak` его не трогает; дом и PATH
  // стенда всё равно главнее.
  env: extraEnv = {},
  // Ядро задач рядом с панелью (этап 9): `true` или `{ stub: [...] }` — свой процесс
  // `apps/core` со своим временным домом, тем же, что видит прокладка панели
  // (`AGENTDECK_CORE_HOME`). Маршруты моделей — только заглушки `packages/stub-model`
  // (раздел `routes.stub` настройки ядра): настоящий CLI и сеть стенду не нужны.
  core = false,
} = {}) {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), `cc-${label}-`)));
  const home = join(root, 'home');
  const cfg = join(home, '.claude');
  const appData = join(home, 'AppData', 'Roaming');
  const localAppData = join(home, 'AppData', 'Local');
  const stateDir = noClaude ? join(home, '.agentdeck', 'data') : join(cfg, 'agentdeck');
  for (const dir of [stateDir, appData, localAppData]) mkdirSync(dir, { recursive: true });
  if (!noClaude) writeFileSync(join(cfg, 'settings.json'), '{}\n', 'utf8');
  // Шлюз и DLP-прокси по умолчанию слушают 5179 — порт живого стенда человека.
  // Проверка, включившая их на одноразовом стенде без своего порта, заняла бы
  // чужой адрес (или, пока живой стенд перезапускается, приняла бы его трафик).
  // Поэтому свои свободные порты кладём сразу; объекты целиком — настройки
  // сливаются с умолчаниями на один уровень. Порт из `settings` вызывающего главнее.
  const isolated = {
    platformGateway: { enabled: false, port: await freePort(), forceStream: true },
    dlp: {
      enabled: false,
      port: await freePort(),
      upstreamUrl: '',
      upstreamProfileId: '',
      passUnknown: false,
      journal: true,
    },
  };
  writeFileSync(
    join(stateDir, 'state.json'),
    `${JSON.stringify({ settings: { onboardingDone: true, language: 'ru', theme: 'light', ...isolated, ...settings } })}\n`,
    'utf8',
  );
  const coreHome = core ? join(root, 'core-home') : '';
  const hopFile = core ? join(root, 'core-hops.json') : '';
  if (core) {
    mkdirSync(coreHome, { recursive: true });
    const stub = core === true || !core.stub ? DEFAULT_CORE_STUBS : core.stub;
    writeFileSync(
      join(coreHome, 'config.json'),
      `${JSON.stringify({ routes: { stub } }, null, 2)}\n`,
      'utf8',
    );
  }
  if (seed) await seed({ root, home, cfg, coreHome });

  // Фальшивые CLI (`fakeCli: { claude: '<исходник .mjs>' }`) — первыми в PATH
  // панели: скрипт запускается этим же node через обёртку под именем CLI. Так
  // проверка видит, что ДОШЛО до процесса (argv, stdin), не трогая настоящий.
  const bin = join(root, 'bin');
  const shellPath = pathWithoutClaude(hideCli, join(root, 'path'));
  const fakes =
    shellPath.keptClaude && !fakeCli.claude ? { ...fakeCli, claude: BLOCKED_CLAUDE } : fakeCli;
  const fakeNames = Object.keys(fakes);
  if (fakeNames.length > 0) {
    mkdirSync(bin, { recursive: true });
    // Метка жизни стенда: фальшивый CLI сам выходит, когда её нет. Процесс CLI
    // на разговор держит stdin открытым, а убитый сервер на Windows не уносит
    // его с собой — без метки он пережил бы стенд и держал бы его каталог.
    writeFileSync(join(bin, STAND_ALIVE), '', 'utf8');
    for (const name of fakeNames) {
      const script = join(bin, `${name}.mjs`);
      writeFileSync(script, fakes[name], 'utf8');
      if (IS_WIN) {
        writeFileSync(
          join(bin, `${name}.cmd`),
          `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`,
        );
      } else {
        writeFileSync(join(bin, name), `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`, {
          mode: 0o755,
        });
      }
    }
  }

  const homeEnv = {
    HOME: home,
    USERPROFILE: home,
    ...(noClaude ? {} : { CLAUDE_CONFIG_DIR: cfg }),
    APPDATA: appData,
    LOCALAPPDATA: localAppData,
  };
  // Переменные панели человека (AGENTDECK_*, прежнее имя) увели бы одноразовый
  // стенд в его каталоги — поэтому не наследуются.
  // Переменные дома чужих CLI, пришедшие из оболочки человека, — тоже (`shellLeak`).
  const base = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key, value]) =>
        !PANEL_ENV_PREFIXES.some((prefix) => key.toUpperCase().startsWith(prefix)) &&
        !['PATH', 'PORT', 'API_PORT', 'CLAUDE_CONFIG_DIR', ...Object.keys(homeEnv)].includes(
          key.toUpperCase(),
        ) &&
        !shellLeak(key, value),
    ),
  );
  const env = {
    ...base,
    // Веб-цель «Dev-сервера» открыла бы браузер ОС на рабочем столе человека, с
    // домом стенда в профиле: окно висит, каталог стенда не удаляется.
    AGENTDECK_OPEN_BROWSER: '0',
    // Каталог локальных моделей по умолчанию — `.local-models` репозитория, общий с
    // панелью человека: поставленный там qwen вставал в PATH стенда раньше подставного
    // («No auth type is selected», прогон 21.10), а стенд мог подхватить его сервер
    // моделей. Свой пустой каталог; проверка с настоящими моделями задаёт свой в `env`.
    AGENTDECK_LOCAL_MODELS_DIR: join(root, 'local-models'),
    // Дом ядра — общий у панели (прокладка читает его procs.json и token) и у ядра стенда.
    // Итог записи звеньев — файл сторожа стенда: прокладка не шлёт команду ядру, пока её pid
    // не записан (P131), ровно как у `dev-watch`.
    ...(core ? { AGENTDECK_CORE_HOME: coreHome, [HOP_RECORD_ENV]: hopFile } : {}),
    ...extraEnv,
    ...homeEnv,
    PATH: [...(fakeNames.length > 0 ? [bin] : []), shellPath.path, ...extraPath].join(delimiter),
  };

  const apiPort = await freePort();
  const webPort = web ? await freePort() : 0;
  const children = [];
  let hops;
  let stopped;
  /**
   * Снять стенд. Хосты сессий ядра — после панели и ядра (снятое ядро новых не запустит) и до
   * удаления каталога: живой хост держал его, и удаление падало EBUSY, унося с собой и снятие.
   * Удаление, которое всё же не прошло, стенд не роняет — уборка не должна прятать итог
   * проверки. Итог: `left` — процессы ядра, которые снять не вышло, `removeError` — почему
   * каталог остался; оба ещё и строкой в вывод.
   */
  const stop = () => {
    stopped ??= (async () => {
      hops?.stop();
      if (fakeNames.length > 0) {
        rmSync(join(bin, STAND_ALIVE), { force: true });
        await wait(700);
      }
      for (const child of children) killTree(child);
      reapStandRelays(stateDir);
      const reaped = coreHome ? reapCoreSessions(coreHome) : { ids: [] };
      let left = liveCoreSessions(reaped.ids);
      // TerminateProcess асинхронен: процесс уходит из снимка не мгновенно.
      for (let round = 0; left.length > 0 && round < 6; round += 1) {
        await wait(500);
        left = liveCoreSessions(left);
      }
      await wait(500);
      let removeError;
      try {
        rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
      } catch (error) {
        removeError = error instanceof Error ? error.message : String(error);
      }
      for (const id of left) {
        console.log(`стенд: не снят процесс ядра (${id.role}) pid ${id.pid}: ${id.why}`);
      }
      if (removeError) console.log(`стенд: каталог ${root} не удалён: ${removeError}`);
      return { left, ...(removeError ? { removeError } : {}) };
    })();
    return stopped;
  };
  // `finally` не выполняется, когда процесс уносят снаружи: без этого панель
  // переживала бы свой прогон, а отвязанные хосты сессий ядра — и панель.
  const reap = () => {
    children.forEach(killTree);
    if (coreHome) reapCoreSessions(coreHome);
  };
  process.once('exit', reap);
  process.once('SIGINT', () => {
    reap();
    process.exit(130);
  });
  // `junit-run` снимает проверку по таймауту SIGTERM-ом: node умирает от него
  // без `exit`, и сервер с Vite стенда жили бы дальше во временном доме.
  process.once('SIGTERM', () => {
    reap();
    process.exit(143);
  });

  let log = '';
  const spawnServer = () => {
    const child = spawn(
      process.execPath,
      ['--experimental-strip-types', '--no-warnings', 'src/index.ts'],
      {
        cwd: serverDir,
        env: { ...env, PORT: String(apiPort), WEB_PORT: String(webPort || apiPort + 1) },
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: false,
        windowsHide: true,
      },
    );
    child.stdout.on('data', (chunk) => (log += chunk));
    child.stderr.on('data', (chunk) => (log += chunk));
    child.on(
      'exit',
      (code, signal) => (log += `\n[панель вышла: код ${code}, сигнал ${signal}]\n`),
    );
    children.push(child);
    return child;
  };
  let server = spawnServer();
  if (web) {
    children.push(
      spawn(
        process.execPath,
        [
          join('node_modules', 'vite', 'bin', 'vite.js'),
          '--port',
          String(webPort),
          '--strictPort',
          '--host',
          '127.0.0.1',
        ],
        {
          cwd: join(REPO, 'apps/web'),
          env: {
            ...env,
            PATH: process.env.PATH ?? process.env.Path,
            API_PORT: String(apiPort),
            BROWSER: 'none',
          },
          stdio: 'ignore',
          shell: false,
          windowsHide: true,
        },
      ),
    );
  }

  const apiUrl = `http://127.0.0.1:${apiPort}`;
  const webUrl = `http://127.0.0.1:${webPort}`;
  if (!(await waitFor(`${apiUrl}/api/system`, 60, () => server.exitCode !== null))) {
    await stop();
    // Панель упала исключением из своего же кода — это дефект продукта, а не стенд:
    // иначе сломанный сервер читался бы «не проверено» и в прогоне, и в проверке
    // набора поломкой (живая проверка 08.10: восемь кейсов «нет результата»).
    const thrown = codeCrash(log);
    if (thrown) throw new Error(`одноразовая панель упала на коде ${thrown}:\n${log.slice(-2000)}`);
    throw new NotChecked(`одноразовая панель не поднялась:\n${log.slice(-2000)}`);
  }
  if (web && !(await waitFor(webUrl, 90))) {
    await stop();
    throw new NotChecked('одноразовый фронт не поднялся.');
  }

  // Ядро — после панели: готовность меряется настоящей дорогой браузера (панель → прокладка
  // → сверка строки procs.json → ядро), а не прямым запросом к порту ядра.
  let coreLog = '';
  let coreChild;
  if (core) {
    // Сторож звеньев стенда — тот же `watchHops`, что у `dev-watch`: звенья — сервер панели и
    // слушатель фронта; ядро, поднятое ниже, записывается первым же опросом после своей строки
    // в procs.json. Обхода только для проверок нет: стенд доверен ядру тем же путём, что прод.
    hops = watchHops({
      coreHome,
      pidsOf: () => [server.pid, ...(web ? [listenerPid(webPort)] : [])],
      file: hopFile,
      everyMs: 300,
    });
    await hops.refresh();
    coreChild = spawn(
      process.execPath,
      ['--experimental-strip-types', '--no-warnings', 'src/index.ts', '--home', coreHome],
      {
        cwd: join(REPO, 'apps/core'),
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: false,
        windowsHide: true,
      },
    );
    coreChild.stdout.on('data', (chunk) => (coreLog += chunk));
    coreChild.stderr.on('data', (chunk) => (coreLog += chunk));
    coreChild.on(
      'exit',
      (code, signal) => (coreLog += `\n[ядро вышло: код ${code}, сигнал ${signal}]\n`),
    );
    children.push(coreChild);
    if (!(await waitFor(`${apiUrl}/api/core/health`, 90, () => coreChild.exitCode !== null))) {
      await stop();
      const thrown = codeCrash(coreLog);
      if (thrown) throw new Error(`ядро стенда упало на коде ${thrown}:\n${coreLog.slice(-2000)}`);
      throw new NotChecked(`ядро стенда не поднялось:\n${coreLog.slice(-2000)}`);
    }
  }

  /** Запрос к API одноразовой панели; ответ разобран, если это JSON. */
  async function api(path, init = {}) {
    const hasBody = init.body !== undefined;
    const res = await fetch(`${apiUrl}/api${path}`, {
      ...init,
      body: hasBody && typeof init.body !== 'string' ? JSON.stringify(init.body) : init.body,
      headers: {
        ...(hasBody ? { 'content-type': 'application/json' } : {}),
        ...(init.headers ?? {}),
      },
    });
    const text = await res.text();
    let body = text;
    try {
      body = text ? JSON.parse(text) : undefined;
    } catch {
      // не JSON — отдаём как есть
    }
    return { status: res.status, body, text };
  }

  /** Новая вкладка с журналом ошибок страницы. */
  async function newPage(browser, { width = 1440, height = 950 } = {}) {
    const page = await browser.newPage({ viewport: { width, height } });
    page.errors = [];
    page.on('pageerror', (error) => page.errors.push(error.message));
    return page;
  }

  const read = (path) => (existsSync(path) ? readFileSync(path, 'utf8') : null);

  /**
   * Жёсткий перезапуск панели: снять ОДИН процесс сервера без обработчиков
   * выхода (на Windows `kill()` — это `TerminateProcess`, ровно как `node
   * --watch` при правке файла; его дети остаются жить) и поднять заново на том
   * же доме и порту. Номер снятого процесса — в ответе.
   */
  async function restartHard() {
    const killedPid = server.pid;
    server.kill('SIGKILL');
    await new Promise((resolve) =>
      server.exitCode !== null ? resolve() : server.once('exit', resolve),
    );
    server = spawnServer();
    if (!(await waitFor(`${apiUrl}/api/system`, 60, () => server.exitCode !== null))) {
      throw new Error(`панель не поднялась после жёсткого перезапуска:\n${log.slice(-2000)}`);
    }
    // Новый сервер — новое звено; прежний pid ядро снимает этой же записью.
    await hops?.refresh();
    return { killedPid, pid: server.pid };
  }

  return {
    root,
    home,
    cfg,
    bin,
    apiUrl,
    webUrl,
    api,
    newPage,
    read,
    stop,
    restartHard,
    serverPid: () => server.pid,
    log: () => log,
    coreHome,
    corePid: () => coreChild?.pid,
    coreLog: () => coreLog,
  };
}

/**
 * Итог проверки: «ок / ПЛОХО» построчно и код выхода 0/1. `NotChecked` — стенд
 * не поднялся: код 2, чтобы окружение не выглядело дефектом продукта.
 */
export function reporter() {
  let failures = 0;
  const check = (name, condition, detail = '') => {
    if (condition) console.log(`  ✓ ${name}`);
    else {
      failures += 1;
      console.log(`  ✗ ${name}${detail ? `\n    ${detail}` : ''}`);
    }
    return condition;
  };
  const finish = () => {
    console.log(failures === 0 ? '\nВсё сходится.' : `\nПровалов: ${failures}`);
    process.exit(failures === 0 ? 0 : 1);
  };
  return { check, finish, failed: () => failures };
}

/** Общий вход проверки: стенд, сценарий, итог; сбой сценария — провал с причиной. */
export async function runOnStand(options, scenario) {
  const { check, finish } = reporter();
  let stand;
  try {
    stand = await startStand(options);
    console.log(
      `Одноразовая панель ${stand.apiUrl}${options.web === false ? '' : `, фронт ${stand.webUrl}`}\n`,
    );
    await scenario(stand, check);
  } catch (error) {
    if (error instanceof NotChecked) {
      console.log(`Не проверено: ${error.message}`);
      if (stand) await stand.stop();
      process.exit(2);
    }
    check('сценарий дошёл до конца', false, error?.stack ?? String(error));
    // `fetch failed` посреди сценария — обычно упавшая панель; без её журнала
    // причина терялась вместе со стендом.
    if (stand) console.log(`\nЖурнал панели (хвост):\n${stand.log().slice(-4000)}`);
  } finally {
    if (stand) await stand.stop();
  }
  finish();
}
