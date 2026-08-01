import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Marketplace, Plugin, PluginsState } from '@claude-control/contracts';
import { defaultCliCommand } from '../../providers/cli.ts';
import { runClaude } from './cli.ts';

/**
 * Чтение каталога плагинов: что установлено, что доступно и какие маркетплейсы
 * подключены. Список установленного отдаёт CLI, маркетплейсы лежат файлом.
 */

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
export async function readPlugins(
  claudeRoot: string,
  command: string = defaultCliCommand(),
): Promise<PluginsState> {
  const installed = await readInstalled(command);
  return { installed, available: [], marketplaces: readMarketplaces(claudeRoot) };
}

/** Каталог маркетплейсов: отдельный запрос, выполняется по требованию. */
export async function readAvailablePlugins(
  command: string = defaultCliCommand(),
): Promise<Plugin[]> {
  return readAvailable(command, await readInstalled(command));
}

async function readInstalled(command: string): Promise<Plugin[]> {
  try {
    const { stdout } = await runClaude(command, ['plugin', 'list', '--json'], 60_000);
    return parseList(stdout, 'installed').map((item) => toPlugin(item, true));
  } catch {
    // CLI недоступен или сменил формат — раздел покажет пустой список,
    // но приложение не должно из-за этого падать целиком.
    return [];
  }
}

async function readAvailable(command: string, installed: Plugin[]): Promise<Plugin[]> {
  try {
    const { stdout } = await runClaude(
      command,
      ['plugin', 'list', '--available', '--json'],
      180_000,
    );
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
