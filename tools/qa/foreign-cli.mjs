/**
 * Общее у живых проверок чужих CLI (`check-foreign-steer.mjs`,
 * `check-foreign-session.mjs`): где лежит CLI, его окружение на стенд с заглушкой
 * модели и снятие процессов, переживших стенд.
 *
 * CLI — настоящие: из `STEER_CLI_DIR` (каталоги через разделитель PATH), иначе из
 * PATH. Дома CLI — временные каталоги: настоящие `~/.codex`, `~/.qwen`, данные
 * Goose, `~/.kimi-code` и конфиг OpenCode не трогаются.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { killProcessTree } from '../../apps/server/src/lib/kill-tree.mjs';

const IS_WIN = process.platform === 'win32';

/** Где лежит CLI: сначала `STEER_CLI_DIR`, потом PATH. */
export function findCli(name) {
  const cliDir = process.env.STEER_CLI_DIR;
  const names = IS_WIN ? [`${name}.cmd`, `${name}.exe`, name] : [name];
  const dirs = [
    ...(cliDir ? cliDir.split(delimiter) : []),
    ...(process.env.PATH ?? process.env.Path ?? '').split(delimiter),
  ];
  return dirs.find((dir) => dir && names.some((file) => existsSync(join(dir, file))));
}

/** Один вид разделителя; регистр складывается только на Windows — там он не различает пути. */
const norm = (text) => {
  const slashed = text.replace(/[\\/]+/g, '/').replace(/\/+$/, '');
  return IS_WIN ? slashed.toLowerCase() : slashed;
};

/**
 * Настоящий путь: `tmpdir()` на Windows отдаёт короткое имя (`RUSYAN~1`), а дети
 * CLI пишут длинное; на macOS `/var/folders/…` — это `/private/var/folders/…`.
 */
const long = (path) => {
  try {
    return realpathSync.native(path);
  } catch {
    return path;
  }
};

/**
 * Признаки CLI в командной строке процесса. `within` — подстрока, `path` — слово
 * строки, равное пути или лежащее под ним.
 *
 * Windows: каталог CLI — `%APPDATA%\npm`, в нём одни обёртки, подстроки хватает.
 * POSIX: каталог CLI — тот же, что у node (nvm, `/usr/bin`, Homebrew), и по
 * подстроке под снятие попадали сервер стенда, панель и чужой `python3`, а сам
 * CLI — нет: Codex запускает свой бинарь из `node_modules/@openai/codex/vendor/…`.
 * Там признак — путь CLI (как вызвали и настоящий) и каталог его пакета npm.
 */
export function cliNeedles(dir, name, homes = []) {
  const own = homeNeedles(homes);
  if (IS_WIN) return [{ within: norm(dir) }, ...own];
  const entry = join(dir, name);
  const real = norm(long(entry));
  const pkg = /^(.*\/node_modules\/(?:@[^/]+\/)?[^/]+)\//.exec(real)?.[1];
  return [{ path: norm(entry) }, { path: real }, ...(pkg ? [{ path: pkg }] : []), ...own];
}

/** Признаки временных домов прогона — их до прогона не было, путь у прогона свой. */
function homeNeedles(homes) {
  return homes.flatMap((home) => [home, long(home)]).map((home) => ({ within: norm(home) }));
}

/** Подходит ли командная строка под один из признаков. */
export function matchesCli(args, needles) {
  const text = norm(args);
  const words = text.split(/\s+/);
  return needles.some((needle) =>
    needle.within === undefined
      ? words.some((word) => word === needle.path || word.startsWith(`${needle.path}/`))
      : text.includes(needle.within),
  );
}

/**
 * PID процессов CLI и тех, что запущены из временных домов прогона. Стенд снимает
 * панель жёстко, и её `exit`, гасящий `opencode serve`, не успевает отработать:
 * сервер CLI пережил бы проверку. Снимаем ровно то, чего до прогона не было.
 */
export function cliProcesses(dir, name, homes = []) {
  const needles = cliNeedles(dir, name, homes);
  try {
    const rows = IS_WIN
      ? execFileSync(
          'powershell',
          [
            '-NoProfile',
            '-Command',
            'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId)`t$($_.CommandLine)" }',
          ],
          { encoding: 'utf8' },
        )
      : execFileSync('ps', ['-eo', 'pid=,args='], { encoding: 'utf8' });
    return new Set(
      rows
        .split(/\r?\n/)
        .map((row) => row.trim().match(/^(\d+)\s+(.*)$/))
        .filter((match) => match && matchesCli(match[2], needles))
        .map((match) => Number(match[1])),
    );
  } catch {
    return new Set();
  }
}

/**
 * Таблица процессов: родитель, старт (мс, 0 — неизвестен) и командная строка.
 * Старт отличает настоящего родителя от процесса, получившего его номер позже.
 */
function processTable() {
  try {
    const rows = IS_WIN
      ? execFileSync(
          'powershell',
          [
            '-NoProfile',
            '-Command',
            'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId)`t$($_.ParentProcessId)`t$(if ($_.CreationDate) { ([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds() } else { 0 })`t$($_.CommandLine)" }',
          ],
          { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
        )
      : execFileSync('ps', ['-eo', 'pid=,ppid=,lstart=,args='], {
          encoding: 'utf8',
          env: { ...process.env, LC_ALL: 'C' },
        });
    return parseProcessRows(rows, IS_WIN);
  } catch {
    return new Map();
  }
}

/**
 * Строки таблицы → `pid → { ppid, start, args }`. Windows — через табуляцию, старт в мс;
 * POSIX — `ps … lstart` («Sat Oct 24 18:00:00 2026» под `LC_ALL=C`, с точностью до секунды).
 */
export function parseProcessRows(rows, windows) {
  const table = new Map();
  for (const row of rows.split(/\r?\n/)) {
    const line = row.trim();
    const match = windows
      ? /^(\d+)\t(\d+)\t(\d+)\t(.*)$/.exec(line)
      : /^(\d+)\s+(\d+)\s+(\w{3}\s+\w{3}\s+\d+\s+[\d:]+\s+\d{4})\s+(.*)$/.exec(line);
    if (!match) continue;
    const start = windows ? Number(match[3]) : Date.parse(match[3]);
    table.set(Number(match[1]), {
      ppid: Number(match[2]),
      start: Number.isFinite(start) ? start : 0,
      args: match[4] ?? '',
    });
  }
  return table;
}

// Сироту на POSIX усыновляет init/launchd или подсборщик `systemd --user`: такой родитель — не владелец.
const ADOPTER = /^(?:\S*\/)?(?:systemd|launchd|init)(?:\s|$)/;

/** Живой родитель процесса или `undefined`: родителя нет, его номер занят позже, сирота. */
function liveParent(table, pid, self) {
  const row = table.get(pid);
  if (!row) return undefined;
  if (row.ppid === self) return self;
  const parent = table.get(row.ppid);
  if (!parent || row.ppid <= 1) return undefined;
  if (parent.start && row.start && parent.start > row.start) return undefined;
  if (ADOPTER.test(parent.args)) return undefined;
  return row.ppid;
}

/**
 * Что из таблицы — остаток ЭТОГО прогона. Признак CLI (его каталог) — общий для всех:
 * под ним и чат человека в живой панели, и CLI соседней проверки. Снимать их нельзя
 * (kit-029: 3 из 8 прогонов теряли OpenCode — его снимала соседняя проверка, 24.10).
 * Свой — процесс из временного дома прогона; CLI, чьи живые предки поднимаются к этому
 * процессу; CLI, чья цепочка оборвалась (стенд снят жёстко) на предке, родившемся уже во
 * время прогона. Цепочка панели человека или соседней проверки упирается в процесс
 * старше прогона (терминал, рабочий стол) — она чужая. Старт неизвестен — только потомки.
 */
export function runLeftovers(table, { before, self, cli, own }) {
  const since = table.get(self)?.start ?? 0;
  const ours = (pid) => {
    const seen = new Set();
    let root = pid;
    for (let at = pid; at !== undefined && !seen.has(at); at = liveParent(table, at, self)) {
      if (at === self) return true;
      seen.add(at);
      root = at;
    }
    const start = table.get(root)?.start ?? 0;
    return since > 0 && start >= since;
  };
  const out = [];
  for (const [pid, row] of table) {
    if (before.has(pid) || pid === self) continue;
    if (own.length > 0 && matchesCli(row.args, own)) out.push(pid);
    else if (matchesCli(row.args, cli) && ours(pid)) out.push(pid);
  }
  return out;
}

/**
 * `homes` — временные дома прогона: их до прогона не было, и всё, что запущено
 * оттуда, — его остаток (Codex клонирует плагины `git` в свой дом, и клон
 * переживает стенд, держа каталог). CLI вне домов снимается, только если он свой
 * (`runLeftovers`).
 */
export function reap(before, dir, name, homes = []) {
  const leftovers = runLeftovers(processTable(), {
    before,
    self: process.pid,
    cli: cliNeedles(dir, name),
    own: homeNeedles(homes),
  });
  for (const pid of leftovers) {
    // Деревом: у `git fetch` ребёнок `git remote-https`, в строке которого пути дома нет.
    if (IS_WIN) {
      try {
        execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
      } catch {
        // уже вышел
      }
    } else killProcessTree(pid);
  }
}

/**
 * Окружение CLI на стенд: адрес заглушки и временный дом. Переменные ложатся в
 * окружение процесса проверки до старта стенда — панель наследует их, CLI тоже.
 */
export const FOREIGN_CLIS = {
  codex: {
    transport: 'live',
    env: (root, base) => {
      const home = join(root, 'codex-home');
      mkdirSync(home, { recursive: true });
      writeFileSync(
        join(home, 'config.toml'),
        [
          'model_provider = "stub"',
          'model = "stub-model"',
          '[model_providers.stub]',
          'name = "stub"',
          `base_url = "${base}/v1"`,
          'wire_api = "responses"',
          'env_key = "STUB_KEY"',
          '',
        ].join('\n'),
      );
      return { CODEX_HOME: home, STUB_KEY: 'x' };
    },
  },
  qwen: {
    transport: 'live',
    env: (root, base) => {
      const home = join(root, 'qwen-home');
      mkdirSync(home, { recursive: true });
      return {
        QWEN_HOME: home,
        OPENAI_BASE_URL: `${base}/v1`,
        OPENAI_API_KEY: 'x',
        OPENAI_MODEL: 'stub-model',
      };
    },
  },
  goose: {
    transport: 'live',
    // Дом Goose (APPDATA/XDG) — уже временный дом стенда; ключ — переменной, не связкой ключей.
    env: (_root, base) => ({
      GOOSE_PROVIDER: 'openai',
      GOOSE_MODEL: 'stub-model',
      OPENAI_HOST: base,
      OPENAI_BASE_PATH: 'v1/chat/completions',
      OPENAI_API_KEY: 'x',
      GOOSE_DISABLE_KEYRING: '1',
    }),
  },
  kimi: {
    transport: 'live',
    // Модель — запись своей таблицы `[models]` в config.toml; `auto` — инструмент
    // заглушки выполняется без вопроса, как в `kimi -p`.
    env: (root, base) => {
      const home = join(root, 'kimi-home');
      mkdirSync(home, { recursive: true });
      writeFileSync(
        join(home, 'config.toml'),
        [
          'default_model = "stub"',
          'default_permission_mode = "auto"',
          '[providers.stub]',
          'type = "openai"',
          `base_url = "${base}/v1"`,
          'api_key = "x"',
          '[models.stub]',
          'provider = "stub"',
          'model = "stub-model"',
          'max_context_size = 128000',
          '',
        ].join('\n'),
      );
      return { KIMI_CODE_HOME: home };
    },
  },
  opencode: {
    transport: 'session',
    env: (root, base) => {
      const config = join(root, 'opencode.json');
      writeFileSync(
        config,
        JSON.stringify({
          $schema: 'https://opencode.ai/config.json',
          provider: {
            stub: {
              npm: '@ai-sdk/openai-compatible',
              name: 'stub',
              options: { baseURL: `${base}/v1`, apiKey: 'x' },
              models: { 'stub-model': { name: 'stub', tool_call: true } },
            },
          },
          model: 'stub/stub-model',
          permission: { bash: 'allow', edit: 'allow' },
        }),
      );
      const xdg = (name) => {
        const dir = join(root, name);
        mkdirSync(dir, { recursive: true });
        return dir;
      };
      return {
        OPENCODE_CONFIG: config,
        XDG_CONFIG_HOME: xdg('xdg-config'),
        XDG_DATA_HOME: xdg('xdg-data'),
        XDG_STATE_HOME: xdg('xdg-state'),
        XDG_CACHE_HOME: xdg('xdg-cache'),
      };
    },
  },
};

/**
 * Окружение CLI в процесс проверки и каталог CLI первым в PATH; вернуть
 * функцию, кладущую прежние значения обратно.
 */
export function applyCliEnv(added, dir) {
  const saved = { PATH: process.env.PATH };
  for (const key of Object.keys(added)) saved[key] = process.env[key];
  Object.assign(process.env, added, { PATH: `${dir}${delimiter}${process.env.PATH ?? ''}` });
  return () => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}
