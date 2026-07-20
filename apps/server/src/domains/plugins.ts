import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { CommandResult, Marketplace, Plugin, PluginsState } from '@claude-control/contracts';
import { safePluginId } from '../lib/cli-args.ts';

const execFileAsync = promisify(execFile);

/**
 * Работа с плагинами через штатный CLI Claude Code. Установка плагина —
 * это клонирование репозитория маркетплейса и обновление нескольких файлов
 * состояния; воспроизводить это своими руками нельзя, иначе состояние
 * разъедется с тем, что видит сам Claude Code.
 */

/** На Windows claude — это .cmd-обёртка, её нельзя запустить без shell. */
const isWindows = process.platform === 'win32';

async function runClaude(
  args: string[],
  timeoutMs = 180_000,
): Promise<{ stdout: string; stderr: string }> {
  const command = isWindows ? 'claude.cmd' : 'claude';
  return execFileAsync(command, args, {
    timeout: timeoutMs,
    windowsHide: true,
    shell: isWindows,
    maxBuffer: 10 * 1024 * 1024,
  });
}

/**
 * CLI отдаёт установленные и доступные плагины в разной форме: `plugin list
 * --json` — массив с полем id, а `--available` — объект `{installed, available}`,
 * где у записей каталога поля названы иначе (pluginId, marketplaceName).
 * Поэтому здесь оба набора имён.
 */
interface RawPlugin {
  id?: string;
  pluginId?: string;
  name?: string;
  version?: string;
  scope?: string;
  enabled?: boolean;
  installPath?: string;
  installedAt?: string;
  lastUpdated?: string;
  description?: string;
  marketplaceName?: string;
  /** Сколько раз плагин установили — по нему сортируется каталог. */
  installCount?: number;
}

function toPlugin(raw: RawPlugin, isInstalled: boolean): Plugin {
  const id = raw.pluginId ?? raw.id ?? '';
  const [idName = id, idMarketplace = ''] = id.split('@');

  return {
    id,
    name: raw.name ?? idName,
    marketplace: raw.marketplaceName ?? idMarketplace,
    version: raw.version ?? 'unknown',
    scope: raw.scope ?? 'user',
    isEnabled: raw.enabled ?? false,
    installPath: raw.installPath,
    installedAt: raw.installedAt,
    lastUpdated: raw.lastUpdated,
    isInstalled,
    description: raw.description,
    installCount: raw.installCount,
  };
}

/**
 * Быстрый путь: только установленные плагины и маркетплейсы. Каталог доступных
 * запрашивается отдельно, потому что CLI за ним ходит в сеть и обновляет
 * репозитории маркетплейсов — держать из-за этого весь раздел в загрузке нельзя.
 */
export async function readPlugins(claudeRoot: string): Promise<PluginsState> {
  const installed = await readInstalled();
  return { installed, available: [], marketplaces: readMarketplaces(claudeRoot) };
}

/** Каталог маркетплейсов: отдельный запрос, выполняется по требованию. */
export async function readAvailablePlugins(): Promise<Plugin[]> {
  return readAvailable(await readInstalled());
}

async function readInstalled(): Promise<Plugin[]> {
  try {
    const { stdout } = await runClaude(['plugin', 'list', '--json'], 60_000);
    return parseList(stdout, 'installed').map((item) => toPlugin(item, true));
  } catch {
    // CLI недоступен или сменил формат — раздел покажет пустой список,
    // но приложение не должно из-за этого падать целиком.
    return [];
  }
}

async function readAvailable(installed: Plugin[]): Promise<Plugin[]> {
  try {
    const { stdout } = await runClaude(['plugin', 'list', '--available', '--json'], 180_000);
    const installedIds = new Set(installed.map((plugin) => plugin.id));

    return parseList(stdout, 'available')
      .map((item) => toPlugin(item, false))
      .filter((plugin) => plugin.id && !installedIds.has(plugin.id))
      .sort((a, b) => (b.installCount ?? 0) - (a.installCount ?? 0));
  } catch {
    return [];
  }
}

/**
 * Разбор вывода CLI. Перед JSON бывают предупреждения, а сама структура —
 * либо массив, либо объект с ключами installed/available, поэтому нужный
 * список достаём по имени.
 */
function parseList(stdout: string, key: 'installed' | 'available'): RawPlugin[] {
  const start = stdout.search(/[[{]/);
  if (start < 0) return [];

  const end = Math.max(stdout.lastIndexOf(']'), stdout.lastIndexOf('}'));
  if (end <= start) return [];

  const parsed: unknown = JSON.parse(stdout.slice(start, end + 1));
  if (Array.isArray(parsed)) return parsed as RawPlugin[];

  const list = (parsed as Record<string, unknown>)[key];
  return Array.isArray(list) ? (list as RawPlugin[]) : [];
}

function readMarketplaces(claudeRoot: string): Marketplace[] {
  const file = join(claudeRoot, 'plugins', 'known_marketplaces.json');
  if (!existsSync(file)) return [];

  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Record<
      string,
      {
        source?: { source?: string; repo?: string };
        installLocation?: string;
        lastUpdated?: string;
      }
    >;

    return Object.entries(parsed).map(([name, value]) => ({
      name,
      source: value.source?.repo ?? value.source?.source ?? '',
      installLocation: value.installLocation,
      lastUpdated: value.lastUpdated,
    }));
  } catch {
    return [];
  }
}

async function runPluginCommand(args: string[]): Promise<CommandResult> {
  try {
    const { stdout, stderr } = await runClaude(['plugin', ...args]);
    return { ok: true, output: (stdout || stderr).trim(), needsRestart: true };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const output = (error as { stdout?: string; stderr?: string }).stderr ?? detail;
    return { ok: false, output: output.trim(), needsRestart: false };
  }
}

/**
 * Источник маркетплейса — репозиторий, URL или путь. Значение уходит в команду,
 * а на Windows команда идёт через оболочку, поэтому метасимволы и пробел сюда не
 * пускаем: разрешены только буквы, цифры и безопасные знаки адреса/пути.
 */
const MARKETPLACE_SOURCE = /^[A-Za-z0-9._~:/@\\-]{1,300}$/;

/** Добавить маркетплейс: `claude plugin marketplace add <источник>`. */
export function addMarketplace(source: string): Promise<CommandResult> {
  if (!MARKETPLACE_SOURCE.test(source)) {
    return Promise.resolve({
      ok: false,
      output: `Недопустимый источник: ${source}`,
      needsRestart: false,
    });
  }
  return runPluginCommand(['marketplace', 'add', source]);
}

/** Убрать маркетплейс по имени: `claude plugin marketplace remove <имя>`. */
export function removeMarketplace(name: string): Promise<CommandResult> {
  if (!MARKETPLACE_SOURCE.test(name)) {
    return Promise.resolve({ ok: false, output: `Недопустимое имя: ${name}`, needsRestart: false });
  }
  return runPluginCommand(['marketplace', 'remove', name]);
}

/**
 * Идентификатор приходит из запроса, а на Windows команда уходит в оболочку —
 * поэтому он сверяется с допустимым видом до запуска. Отказ возвращается
 * обычным ответом: страница плагинов покажет его как результат операции.
 */
function runPluginAction(action: string, id: string): Promise<CommandResult> {
  let checked: string;
  try {
    checked = safePluginId(id);
  } catch (error) {
    return Promise.resolve({
      ok: false,
      output: error instanceof Error ? error.message : String(error),
      needsRestart: false,
    });
  }

  return runPluginCommand([action, checked]);
}

export const installPlugin = (id: string): Promise<CommandResult> => runPluginAction('install', id);

export const uninstallPlugin = (id: string): Promise<CommandResult> =>
  runPluginAction('uninstall', id);

export const enablePlugin = (id: string): Promise<CommandResult> => runPluginAction('enable', id);

export const disablePlugin = (id: string): Promise<CommandResult> => runPluginAction('disable', id);

export const updatePlugin = (id: string): Promise<CommandResult> => runPluginAction('update', id);
