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
  const { plugins: installed, error } = await readInstalled(command);
  return {
    installed,
    available: [],
    marketplaces: readMarketplaces(claudeRoot),
    // Отказ CLI — не «плагинов нет», а «список не получен». Молчаливый ноль
    // читался бы как правда и отправлял бы человека искать пропавшие плагины.
    notes: error ? [`Список плагинов не получен: ${error}`] : [],
  };
}

/**
 * Сколько живёт кэш установленных плагинов для ЧТЕНИЯ ВСКОЛЬЗЬ.
 *
 * Список установленного отдаёт CLI — это запуск процесса, и на этой машине он
 * стоит порядка полусекунды. Раздел «Плагины» столько ждать обязан: там список
 * и есть предмет разговора. А вот глобальный поиск зовёт ту же читалку ради
 * одной строки в выдаче, на КАЖДЫЙ запрос, то есть на каждую паузу в наборе, —
 * и именно из-за неё поиск отвечал секундами.
 *
 * Полминуты выбраны по тому, как плагины меняются на самом деле: их ставят и
 * удаляют руками, отдельным действием, а не по ходу набора запроса. Худшее, что
 * даёт задержка, — свежепоставленный плагин не находится поиском в ближайшие
 * полминуты; в своём разделе он виден сразу, потому что тот кэш не трогает.
 */
const INSTALLED_TTL_MS = 30_000;

let installedCache: { command: string; at: number; plugins: Plugin[] } | undefined;

/**
 * Установленные плагины для тех, кому список нужен вскользь (поиск): свежий
 * ответ CLI или недавний из кэша. Разделу плагинов не предназначено — ему нужен
 * `readPlugins`, спрашивающий CLI каждый раз.
 */
export async function readInstalledPluginsCached(
  command: string = defaultCliCommand(),
  now: number = Date.now(),
): Promise<Plugin[]> {
  if (
    installedCache &&
    installedCache.command === command &&
    now - installedCache.at < INSTALLED_TTL_MS
  ) {
    return installedCache.plugins;
  }

  const { plugins } = await readInstalled(command);
  installedCache = { command, at: now, plugins };

  return plugins;
}

/** Сбросить кэш установленных: панель сама поставила или удалила плагин. */
export function forgetInstalledPlugins(): void {
  installedCache = undefined;
}

/** Каталог маркетплейсов: отдельный запрос, выполняется по требованию. */
export async function readAvailablePlugins(
  command: string = defaultCliCommand(),
): Promise<Plugin[]> {
  return readAvailable(command, (await readInstalled(command)).plugins);
}

async function readInstalled(command: string): Promise<{ plugins: Plugin[]; error?: string }> {
  try {
    const { stdout } = await runClaude(command, ['plugin', 'list', '--json'], 60_000);
    return {
      plugins: parseList(stdout, 'installed').map((item) =>
        describeInstalled(toPlugin(item, true)),
      ),
    };
  } catch (error) {
    // CLI недоступен или сменил формат — раздел покажет пустой список и причину,
    // но приложение не должно из-за этого падать целиком.
    return { plugins: [], error: cliErrorText(error) };
  }
}

/** Что сказал CLI перед смертью: stderr, иначе текст исключения. */
function cliErrorText(error: unknown): string {
  const stderr = (error as { stderr?: unknown }).stderr;
  const text =
    typeof stderr === 'string' && stderr.trim()
      ? stderr
      : error instanceof Error
        ? error.message
        : String(error);
  return text.trim().split('\n')[0]?.slice(0, 300) ?? '';
}

/**
 * Чего `plugin list` о плагине не говорит: описание и есть ли он на диске.
 *
 * Путь установки CLI отдаёт, а описание — нет; оно лежит в манифесте
 * `.claude-plugin/plugin.json` внутри этого пути. И плагин с пропавшим каталогом
 * CLI перечисляет как ни в чём не бывало (проверено на 2.1.177): без пометки
 * «включённый» плагин, от которого не осталось файлов, выглядит рабочим.
 */
function describeInstalled(plugin: Plugin): Plugin {
  if (!plugin.installPath) return plugin;
  if (!existsSync(plugin.installPath)) return { ...plugin, installPathMissing: true };
  return {
    ...plugin,
    description: plugin.description ?? readManifestDescription(plugin.installPath),
  };
}

function readManifestDescription(installPath: string): string | undefined {
  try {
    const manifest = JSON.parse(
      readFileSync(join(installPath, '.claude-plugin', 'plugin.json'), 'utf8'),
    ) as { description?: unknown };
    return typeof manifest.description === 'string' && manifest.description
      ? manifest.description
      : undefined;
  } catch {
    return undefined;
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
        source?: { source?: string; repo?: string; path?: string; url?: string };
        installLocation?: string;
        lastUpdated?: string;
      }
    >;

    // `source.source` — это ВИД источника (github / directory / git), а не адрес.
    // Адрес лежит в соседнем поле, своём для каждого вида: репозиторий, путь
    // или URL. Без этого маркетплейс из папки подписывался словом «directory».
    return Object.entries(parsed).map(([name, value]) => ({
      name,
      source:
        value.source?.repo ?? value.source?.path ?? value.source?.url ?? value.source?.source ?? '',
      installLocation: value.installLocation,
      lastUpdated: value.lastUpdated,
    }));
  } catch {
    return [];
  }
}
