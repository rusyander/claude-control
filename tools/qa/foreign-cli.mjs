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

/**
 * PID процессов, запущенных из каталога CLI. Стенд снимает панель жёстко, и её
 * `exit`, гасящий `opencode serve`, не успевает отработать: сервер CLI
 * пережил бы проверку. Снимаем ровно то, чего до прогона не было.
 */
export function cliProcesses(dir) {
  // Сравниваем без регистра и с одним видом разделителя: Windows пишет путь как придётся.
  const norm = (text) => text.toLowerCase().replace(/[\\/]+/g, '/');
  const needle = norm(dir).replace(/\/+$/, '');
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
        .filter((match) => match && norm(match[2]).includes(needle))
        .map((match) => Number(match[1])),
    );
  } catch {
    return new Set();
  }
}

/**
 * `homes` — временные дома прогона: их до прогона не было, и всё, что запущено
 * оттуда, — его остаток (Codex клонирует плагины `git` в свой дом, и клон
 * переживает стенд, держа каталог).
 */
export function reap(before, dir, homes = []) {
  // `tmpdir()` на Windows отдаёт короткое имя (`RUSYAN~1`), а дети CLI пишут длинное.
  const long = (path) => {
    try {
      return realpathSync.native(path);
    } catch {
      return path;
    }
  };
  const left = [...cliProcesses(dir), ...homes.flatMap((home) => [...cliProcesses(long(home))])];
  for (const pid of new Set(left)) {
    if (before.has(pid) || pid === process.pid) continue;
    try {
      // Деревом: у `git fetch` ребёнок `git remote-https`, в строке которого пути дома нет.
      if (IS_WIN) execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
      else process.kill(pid);
    } catch {
      // уже вышел
    }
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
