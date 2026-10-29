import { existsSync, realpathSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { homeDir } from '../../platform/os-kind.ts';
import { readBytesSync } from '../../platform/safe-io/files.ts';
import { readSettingsObject } from '../sdk-stream/repo-deny.ts';

/**
 * Слой репозитория, который Qwen Code 0.24.3 загрузит в копии (F-86, H2). Безопасного режима
 * «без слоя репозитория, но с MCP» у CLI нет: недоверенная папка (`folderTrust` + `DO_NOT_TRUST`)
 * снимает слой репозитория И не запускает ни одного сервера MCP, сервер ядра тоже
 * (`discoverAllMcpToolsIncremental` выходит при `!isTrustedFolder()`), — шаг без `step_done`.
 * Поэтому сеанс идёт с `folderTrust` выключенным, и ядро само решает, что из слоя копии CLI
 * загрузит:
 * - `.qwen/settings.json` копии сливается целиком. Хуки проекта системные настройки не снимают
 *   (отдельный источник `getProjectHooks`, списка отключения нет, `disableAllHooks` снял бы и хук
 *   ядра), `env` пишется «если не задано». Ключи, чьё действие ядро держит само, — `permissions`
 *   (хук ядра судит каждый вызов, `deny` ещё и несётся), `tools.exclude` (запреты), `mcpServers`
 *   (строгий `--allowed-mcp-server-names` ядра, одноимённый сервер перекрыт системными
 *   настройками), служебные `$schema`/`$version`. Любой другой ключ — отказ запуска с именем
 *   ключа: снять его нечем, а молча пустить значит исполнить слой репозитория.
 * - `.env`: CLI идёт от cwd вверх до дома и берёт первый найденный `<dir>/.qwen/.env` или
 *   `<dir>/.env` (`findEnvFiles`). Ключи обычного `.env` снимает `advanced.excludedEnvVars`
 *   системных настроек; ключи `.qwen/.env` этот список не снимает (`isQwenScopedEnvFile`) — отказ.
 */

const SETTINGS = join('.qwen', 'settings.json');

/** Ключ верхнего уровня → его подключи, чьё действие ядро держит само (`'*'` — любые). */
const HELD: Record<string, readonly string[] | '*'> = {
  $schema: '*',
  $version: '*',
  permissions: ['allow', 'ask', 'deny'],
  tools: ['exclude'],
  mcpServers: '*',
};

/** Список исключений CLI по умолчанию: свой список его заменяет — повторяется. */
export const QWEN_DEFAULT_EXCLUDED_ENV = ['DEBUG', 'DEBUG_MODE'] as const;

export interface QwenRepoLayer {
  /** Файл настроек копии, который CLI загрузит (есть и разобран). */
  settings: string | null;
  /** Ключи файла настроек, которые ядро снять не может (`hooks`, `tools.discoveryCommand`…). */
  held: string[];
  unheld: string[];
  /** `.env`, который CLI загрузит, и его ключи — уходят в `advanced.excludedEnvVars`. */
  dotenv: { path: string; keys: string[] } | null;
  /** `.qwen/.env`, который CLI загрузит: его ключи не исключаются. */
  qwenDotenv: string | null;
  unreadable: string[];
}

/**
 * Ключи `.env` с запасом: каждая строка вида `KEY=` / `export KEY=` / `KEY:` (грамматика
 * `dotenv.parse` — ключ `[\w.-]+` с начала строки после пробелов). Лишний ключ (строка внутри
 * многострочного значения) безвреден: исключение только не даёт `.env` его задать.
 */
export function dotenvKeys(text: string): string[] {
  const keys = new Set<string>();
  for (const line of text.split(/\r\n|\r|\n/)) {
    const m = /^\s*(?:export\s+)?([\w.-]+)\s*[=:]/.exec(line);
    if (m?.[1]) keys.add(m[1]);
  }
  return [...keys];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function settingsKeys(value: Record<string, unknown>): { held: string[]; unheld: string[] } {
  const held: string[] = [];
  const unheld: string[] = [];
  for (const [key, inner] of Object.entries(value)) {
    const allowed = HELD[key];
    if (allowed === '*') held.push(key);
    else if (allowed === undefined || !isRecord(inner)) unheld.push(key);
    else {
      for (const sub of Object.keys(inner)) {
        (allowed.includes(sub) ? held : unheld).push(`${key}.${sub}`);
      }
    }
  }
  return { held, unheld };
}

const real = (path: string): string => {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
};

/** Первый `.env`, который CLI найдёт от `cwd` вверх (до дома — там слой человека). */
function findDotenv(cwd: string, home: string): { path: string; qwen: boolean } | null {
  const stop = real(home);
  let dir = real(cwd);
  for (;;) {
    if (dir === stop) return null;
    const scoped = join(dir, '.qwen', '.env');
    if (existsSync(scoped)) return { path: scoped, qwen: true };
    const plain = join(dir, '.env');
    // Каталог по имени `.qwen`: CLI считает его `.env` своим (`isQwenScopedEnvFile`).
    if (existsSync(plain)) return { path: plain, qwen: basename(dir) === '.qwen' };
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export function qwenRepoLayer(cwd: string, home: string = homeDir()): QwenRepoLayer {
  const out: QwenRepoLayer = {
    settings: null,
    held: [],
    unheld: [],
    dotenv: null,
    qwenDotenv: null,
    unreadable: [],
  };
  const path = join(cwd, SETTINGS);
  const got = readSettingsObject(path, true);
  if (got !== null && 'why' in got) out.unreadable.push(`${path}: ${got.why}`);
  else if (got !== null) {
    out.settings = path;
    Object.assign(out, settingsKeys(got.value));
  }
  const env = findDotenv(cwd, home);
  if (env?.qwen) out.qwenDotenv = env.path;
  else if (env) {
    const bytes = readBytesSync(env.path);
    if ('value' in bytes)
      out.dotenv = { path: env.path, keys: dotenvKeys(bytes.value.toString('utf8')) };
    else if ('unknown' in bytes) out.unreadable.push(`${env.path}: ${bytes.unknown}`);
  }
  return out;
}

/** Отказ запуска недоверенной копии: слой, который ядро не снимет. */
export function qwenRepoLayerRefusal(layer: QwenRepoLayer): string | null {
  if (layer.unreadable.length > 0) {
    return `repo layer unreadable, the core cannot tell what the CLI would load: ${layer.unreadable.join('; ')}`;
  }
  if (layer.unheld.length > 0) {
    return `untrusted copy: repo settings ${layer.settings} set ${layer.unheld.join(', ')}, which the CLI would load and the core cannot strip (mark the repo trusted to run with its layer)`;
  }
  if (layer.qwenDotenv) {
    return `untrusted copy: ${layer.qwenDotenv} would load and its keys cannot be excluded (mark the repo trusted to run with it)`;
  }
  return null;
}

/** Строка журнала: что из слоя копии CLI загрузит и что снято. */
export function qwenRepoLayerDetail(layer: QwenRepoLayer): string | undefined {
  const parts: string[] = [];
  if (layer.settings)
    parts.push(`repo settings loaded with held keys only (${layer.held.join(', ') || 'none'})`);
  if (layer.dotenv) {
    parts.push(
      `repo .env keys excluded: ${layer.dotenv.keys.join(', ') || 'none'} (${layer.dotenv.path})`,
    );
  }
  return parts.length > 0 ? parts.join('; ') : undefined;
}
