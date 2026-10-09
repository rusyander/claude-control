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
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { brandEnvName, legacyEnvName } from '../../apps/server/src/lib/brand.mjs';

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
  /\/\.claude\/agentdeck(\/state\.json)?$/,
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
 * PATH без каталогов, где лежит `claude`: одноразовая панель не должна запускать
 * настоящий CLI (он пошёл бы в сеть и в учётную запись человека). Git и node
 * остаются — без git не работают проекты.
 */
function pathWithoutClaude() {
  const raw = process.env.PATH ?? process.env.Path ?? '';
  const names = IS_WIN ? ['claude.cmd', 'claude.exe', 'claude.ps1', 'claude'] : ['claude'];
  return raw
    .split(delimiter)
    .filter((dir) => dir && !names.some((name) => existsSync(join(dir, name))))
    .join(delimiter);
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
  // Окружение панели сверх унаследованного (дом и конфиг чужого CLI, ключ
  // заглушки). Явное — поэтому чистка `shellLeak` его не трогает; дом и PATH
  // стенда всё равно главнее.
  env: extraEnv = {},
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
  if (seed) await seed({ root, home, cfg });

  // Фальшивые CLI (`fakeCli: { claude: '<исходник .mjs>' }`) — первыми в PATH
  // панели: скрипт запускается этим же node через обёртку под именем CLI. Так
  // проверка видит, что ДОШЛО до процесса (argv, stdin), не трогая настоящий.
  const bin = join(root, 'bin');
  const fakeNames = Object.keys(fakeCli);
  if (fakeNames.length > 0) {
    mkdirSync(bin, { recursive: true });
    // Метка жизни стенда: фальшивый CLI сам выходит, когда её нет. Процесс CLI
    // на разговор держит stdin открытым, а убитый сервер на Windows не уносит
    // его с собой — без метки он пережил бы стенд и держал бы его каталог.
    writeFileSync(join(bin, STAND_ALIVE), '', 'utf8');
    for (const name of fakeNames) {
      const script = join(bin, `${name}.mjs`);
      writeFileSync(script, fakeCli[name], 'utf8');
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
    ...extraEnv,
    ...homeEnv,
    PATH: [...(fakeNames.length > 0 ? [bin] : []), pathWithoutClaude(), ...extraPath].join(
      delimiter,
    ),
  };

  const apiPort = await freePort();
  const webPort = web ? await freePort() : 0;
  const children = [];
  const stop = async () => {
    if (fakeNames.length > 0) {
      rmSync(join(bin, STAND_ALIVE), { force: true });
      await wait(700);
    }
    for (const child of children) killTree(child);
    await wait(500);
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  };
  // `finally` не выполняется, когда процесс уносят снаружи: без этого панель
  // переживала бы свой прогон.
  const reap = () => children.forEach(killTree);
  process.once('exit', reap);
  process.once('SIGINT', () => {
    reap();
    process.exit(130);
  });

  let log = '';
  const server = spawn(
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
  server.stdout.on('data', (chunk) => (log += chunk));
  server.stderr.on('data', (chunk) => (log += chunk));
  server.on('exit', (code, signal) => (log += `\n[панель вышла: код ${code}, сигнал ${signal}]\n`));
  children.push(server);
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

  return { root, home, cfg, bin, apiUrl, webUrl, api, newPage, read, stop, log: () => log };
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
  } finally {
    if (stand) await stand.stop();
  }
  finish();
}
