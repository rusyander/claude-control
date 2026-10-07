import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type {
  ProviderInstalledPlugin,
  ProviderPluginMarketplace,
  ProviderPluginsInfo,
} from '@agentdeck/contracts';
import { readTextFile, writeTextFile, providerBackupName } from '../../lib/safe-io.ts';
import { parseProviderJsonObject } from '../../lib/provider-json.ts';
import { setCodexTableBoolean, UnrecognizedFormatError } from '../../lib/codex-toml.ts';
import {
  PLUGIN_ACTION_TIMEOUT_MS,
  PLUGIN_LIST_TIMEOUT_MS,
  cliTail,
  describeCliFailure,
  serializePluginAction,
  type PluginCliRun,
} from './plugin-cli.ts';
import {
  CodexCliFailedError,
  CodexCliUnavailableError,
  CodexMarketplaceNotFoundError,
  CodexPluginNotFoundError,
  InvalidCodexMarketplaceSourceError,
  InvalidCodexPluginSelectorError,
} from './errors.ts';
import type { ProviderPluginsTarget } from './types.ts';

/**
 * Плагины Codex (MAP 25): `codex plugin list|add|remove --json` и `codex plugin
 * marketplace list|add|remove|upgrade --json`.
 *
 * Источник правды — слова CLI: список поставленного, доступного и рынков он
 * отдаёт JSON-ом, а ставит в собственный кэш `<CODEX_HOME>/plugins/cache/<рынок>/
 * <имя>/<версия>/`, форма которого не опубликована. Панель кэш только ЧИТАЕТ —
 * чтобы показать, что плагин приносит (скиллы, MCP, команды).
 *
 * Включить и выключить плагин команды у CLI нет: признак живёт в config.toml,
 * таблица `[plugins."имя@рынок"]`, ключ `enabled` (её пишет сам `codex plugin
 * add`). Панель меняет ровно эту строку хирургически, с резервной копией, —
 * тем же приёмом, что MCP и права Codex.
 */

/** Потолок длины источника рынка: путь, `owner/repo[@ref]`, адрес git. */
const MAX_SOURCE_LENGTH = 1000;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
/** `имя@рынок`: по одному `@`, без пробелов, кавычек и флага в начале. */
const SELECTOR = /^[^\s@"'`-][^\s@"'`]*@[^\s@"'`]+$/;
/** Имя рынка: как его называет `marketplace list`. */
const MARKETPLACE_NAME = /^[^\s@"'`/\\-][^\s@"'`/\\]*$/;

/** Манифест плагина: Codex читает свой и чужие (Claude, Cursor) — в этом порядке. */
const MANIFESTS = [
  join('.codex-plugin', 'plugin.json'),
  join('.claude-plugin', 'plugin.json'),
  join('.cursor-plugin', 'plugin.json'),
  'plugin.json',
] as const;

const asString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value : undefined;

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** JSON из stdout CLI: от первой `{` — на случай строки-предупреждения перед ним. */
function parseCliJson(stdout: string): Record<string, unknown> {
  const start = stdout.indexOf('{');
  if (start === -1) throw new Error('CLI не вернул JSON.');
  return parseProviderJsonObject<Record<string, unknown>>(stdout.slice(start));
}

/** Сколько обработчиков объявляет `hooks/hooks.json` (форма та же, что у Claude). */
function countHooks(root: string): number {
  const path = join(root, 'hooks', 'hooks.json');
  if (!existsSync(path)) return 0;
  try {
    const events = asRecord(
      parseProviderJsonObject<Record<string, unknown>>(readTextFile(path)).hooks,
    );
    if (!events) return 0;
    return Object.values(events).reduce<number>(
      (sum, groups) =>
        sum +
        (Array.isArray(groups)
          ? groups.reduce<number>((n, group) => {
              const handlers = asRecord(group)?.hooks;
              return n + (Array.isArray(handlers) ? handlers.length : 0);
            }, 0)
          : 0),
      0,
    );
  } catch {
    return 0;
  }
}

/** Имена MCP-серверов: из манифеста (объект) либо из `.mcp.json` рядом. */
function mcpServersOf(root: string, manifest: Record<string, unknown>): string[] {
  const inline = asRecord(manifest.mcpServers);
  if (inline) return Object.keys(asRecord(inline.mcpServers) ?? inline);
  const file = join(root, '.mcp.json');
  if (!existsSync(file)) return [];
  try {
    const raw = parseProviderJsonObject<Record<string, unknown>>(readTextFile(file));
    return Object.keys(asRecord(raw.mcpServers) ?? raw);
  } catch {
    return [];
  }
}

/** Что плагин приносит — по содержимому каталога. Нет каталога или манифеста — пусто. */
function readContent(root: string | undefined): Partial<ProviderInstalledPlugin> {
  if (!root || !isDir(root)) return {};
  const manifestPath = MANIFESTS.map((name) => join(root, name)).find((path) => existsSync(path));
  let manifest: Record<string, unknown> = {};
  let error: string | undefined;
  if (manifestPath) {
    try {
      manifest = parseProviderJsonObject<Record<string, unknown>>(readTextFile(manifestPath));
    } catch (failure) {
      error = failure instanceof Error ? failure.message : String(failure);
    }
  }
  const ui = asRecord(manifest.interface);
  return {
    manifestPath: manifestPath ?? root,
    ...(asString(manifest.description) ? { description: asString(manifest.description)! } : {}),
    ...(asString(ui?.displayName) ? { displayName: asString(ui?.displayName)! } : {}),
    hasSkills: isDir(join(root, 'skills')),
    mcpServers: mcpServersOf(root, manifest),
    hookCount: countHooks(root),
    hasCommands: isDir(join(root, 'commands')),
    hasAgents: isDir(join(root, 'agents')),
    ...(error ? { error } : {}),
  };
}

/** Каталог поставленного плагина в кэше; версии нет в списке — единственный подкаталог. */
function cacheRoot(pluginsDir: string, marketplace: string, name: string, version?: string) {
  const base = join(pluginsDir, 'cache', marketplace, name);
  if (version && isDir(join(base, version))) return join(base, version);
  if (!isDir(base)) return undefined;
  const versions = readdirSync(base, { withFileTypes: true }).filter((entry) =>
    entry.isDirectory(),
  );
  return versions.length === 1 ? join(base, versions[0]!.name) : undefined;
}

/** Строка `codex plugin list --json` → плагин для показа. */
function toPlugin(raw: unknown, pluginsDir: string): ProviderInstalledPlugin | undefined {
  const entry = asRecord(raw);
  const id = asString(entry?.pluginId);
  if (!entry || !id) return undefined;
  const name = asString(entry.name) ?? id.split('@')[0]!;
  const marketplace = asString(entry.marketplaceName) ?? id.split('@')[1];
  const version = asString(entry.version);
  const source = asRecord(entry.source);
  const installed = entry.installed === true;
  const root = installed
    ? cacheRoot(pluginsDir, marketplace ?? '', name, version)
    : asString(source?.path);
  return {
    id,
    name,
    manifestPath: root ?? id,
    hasSkills: false,
    mcpServers: [],
    hookCount: 0,
    hasCommands: false,
    ...readContent(root),
    ...(version ? { version } : {}),
    ...(marketplace ? { marketplace } : {}),
    ...(installed && typeof entry.enabled === 'boolean' ? { enabled: entry.enabled } : {}),
    ...(asString(source?.path) ? { source: asString(source?.path)! } : {}),
    ...(asString(source?.source) ? { sourceType: asString(source?.source)! } : {}),
  };
}

/** Ответ `plugin list --json --available` → поставленные и доступные. */
export function parseCodexPluginList(
  stdout: string,
  pluginsDir: string,
): { installed: ProviderInstalledPlugin[]; available: ProviderInstalledPlugin[] } {
  const raw = parseCliJson(stdout);
  const list = (value: unknown): ProviderInstalledPlugin[] =>
    (Array.isArray(value) ? value : [])
      .map((item) => toPlugin(item, pluginsDir))
      .filter((item): item is ProviderInstalledPlugin => item !== undefined)
      .sort((a, b) => a.id.localeCompare(b.id));
  return { installed: list(raw.installed), available: list(raw.available) };
}

/** Ответ `plugin marketplace list --json` → рынки. */
export function parseCodexMarketplaces(stdout: string): ProviderPluginMarketplace[] {
  const raw = parseCliJson(stdout);
  return (Array.isArray(raw.marketplaces) ? raw.marketplaces : [])
    .map((item) => {
      const entry = asRecord(item);
      const name = asString(entry?.name);
      if (!name) return undefined;
      const root = asString(entry?.root);
      return { name, ...(root ? { root } : {}) };
    })
    .filter((item): item is ProviderPluginMarketplace => item !== undefined)
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Сводка без запуска CLI: списки пусты, их приносит `withCodexPluginState`. */
export function readCodexPluginsInfo(
  target: ProviderPluginsTarget,
  base: Pick<
    ProviderPluginsInfo,
    'providerId' | 'providerName' | 'format' | 'scope' | 'pluginsDir' | 'dirExists' | 'configPath'
  >,
): ProviderPluginsInfo {
  return {
    ...base,
    ...(target.configPath ? { configPath: target.configPath } : {}),
    sections: ['installed'],
    files: [],
    ignored: [],
    filesReadOnly: true,
    packagesPresent: false,
    packages: [],
    preservedPackages: [],
    packagesReadOnly: true,
    installed: [],
    installedActions: true,
    available: [],
    marketplaces: [],
    marketplaceActions: true,
  };
}

/** Один запуск чтения; отказ — текст причины вместо исключения. */
async function readCli(
  run: PluginCliRun,
  args: string[],
): Promise<{ stdout: string } | { error: string }> {
  const result = await run(args, PLUGIN_LIST_TIMEOUT_MS);
  if (result.spawnError || result.timedOut || result.code !== 0) {
    return { error: describeCliFailure(result) };
  }
  return { stdout: result.stdout };
}

/** Дополнить сводку списками CLI. Не ответил — причина в `installedStateError`. */
export async function withCodexPluginState(
  info: ProviderPluginsInfo,
  run: PluginCliRun,
): Promise<ProviderPluginsInfo> {
  const [plugins, markets] = await Promise.all([
    readCli(run, ['list', '--json', '--available']),
    readCli(run, ['marketplace', 'list', '--json']),
  ]);
  const errors: string[] = [];
  let next = info;
  if ('error' in plugins) {
    errors.push(plugins.error);
  } else {
    try {
      next = { ...next, ...parseCodexPluginList(plugins.stdout, info.pluginsDir) };
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  if ('error' in markets) {
    errors.push(markets.error);
  } else {
    try {
      next = { ...next, marketplaces: parseCodexMarketplaces(markets.stdout) };
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  return errors.length > 0 ? { ...next, installedStateError: errors.join('\n') } : next;
}

/** Плагин к установке: `имя@рынок`. */
export function parseCodexPluginSelector(raw: unknown): string {
  const selector = typeof raw === 'string' ? raw.trim() : '';
  if (!SELECTOR.test(selector) || selector.length > MAX_SOURCE_LENGTH) {
    throw new InvalidCodexPluginSelectorError();
  }
  return selector;
}

/** Источник рынка: одна строка, без флага в начале, разумной длины. */
export function parseCodexMarketplaceSource(raw: unknown): string {
  const source = typeof raw === 'string' ? raw.trim() : '';
  if (
    !source ||
    source.length > MAX_SOURCE_LENGTH ||
    CONTROL_CHARS.test(source) ||
    source.startsWith('-')
  ) {
    throw new InvalidCodexMarketplaceSourceError();
  }
  return source;
}

/** Запустить действие по очереди; отказ CLI — исключение с его же словами. */
async function act(run: PluginCliRun, args: string[]): Promise<string> {
  const result = await serializePluginAction(() => run(args, PLUGIN_ACTION_TIMEOUT_MS));
  if (result.spawnError) throw new CodexCliUnavailableError(result.spawnError);
  if (result.timedOut || result.code !== 0) {
    throw new CodexCliFailedError(describeCliFailure(result));
  }
  return cliTail(result, 3);
}

/** Список поставленного словами CLI — для проверки имени перед действием. */
async function listInstalled(
  target: ProviderPluginsTarget,
  run: PluginCliRun,
): Promise<ProviderInstalledPlugin[]> {
  const result = await run(['list', '--json'], PLUGIN_LIST_TIMEOUT_MS);
  if (result.spawnError) throw new CodexCliUnavailableError(result.spawnError);
  if (result.timedOut || result.code !== 0) {
    throw new CodexCliFailedError(describeCliFailure(result));
  }
  return parseCodexPluginList(result.stdout, target.pluginsDir).installed;
}

/** Имя для действия — только id поставленного плагина (CLI молча «удалит» чужое). */
async function requireInstalled(
  target: ProviderPluginsTarget,
  run: PluginCliRun,
  id: string,
): Promise<ProviderInstalledPlugin> {
  const found = (await listInstalled(target, run)).find((plugin) => plugin.id === id);
  if (!found) throw new CodexPluginNotFoundError(id);
  return found;
}

export function installCodexPlugin(run: PluginCliRun, selector: string): Promise<string> {
  return act(run, ['add', selector, '--json']);
}

export async function uninstallCodexPlugin(
  target: ProviderPluginsTarget,
  run: PluginCliRun,
  id: string,
): Promise<string> {
  const found = await requireInstalled(target, run, id);
  return act(run, ['remove', found.id, '--json']);
}

/**
 * Включить или выключить: `enabled` в `[plugins."id"]` config.toml. Таблицы нет
 * (плагин поставлен не через `codex plugin add`, ключ задан иначе) — отказ
 * `UnrecognizedFormatError`, файл не тронут.
 */
export async function setCodexPluginEnabled(
  target: ProviderPluginsTarget,
  run: PluginCliRun,
  id: string,
  enabled: boolean,
  backupDir: string | undefined,
): Promise<string | undefined> {
  const found = await requireInstalled(target, run, id);
  const configPath = target.configPath;
  if (!configPath || !existsSync(configPath)) throw new UnrecognizedFormatError();
  return serializePluginAction(async () => {
    const original = readFileSync(configPath, 'utf8');
    const next = setCodexTableBoolean(original, ['plugins', found.id], 'enabled', enabled);
    if (next === original) return undefined;
    return writeTextFile(configPath, next, {
      backupDir,
      backupName: providerBackupName(target.provider.id, configPath),
      preserveForm: false,
    });
  });
}

export function addCodexMarketplace(run: PluginCliRun, source: string): Promise<string> {
  return act(run, ['marketplace', 'add', source, '--json']);
}

/** Имя рынка — только из подключённых. */
async function requireMarketplace(run: PluginCliRun, name: string): Promise<string> {
  if (!MARKETPLACE_NAME.test(name)) throw new CodexMarketplaceNotFoundError(name);
  const result = await run(['marketplace', 'list', '--json'], PLUGIN_LIST_TIMEOUT_MS);
  if (result.spawnError) throw new CodexCliUnavailableError(result.spawnError);
  if (result.timedOut || result.code !== 0) {
    throw new CodexCliFailedError(describeCliFailure(result));
  }
  if (!parseCodexMarketplaces(result.stdout).some((market) => market.name === name)) {
    throw new CodexMarketplaceNotFoundError(name);
  }
  return name;
}

export async function removeCodexMarketplace(run: PluginCliRun, name: string): Promise<string> {
  return act(run, ['marketplace', 'remove', await requireMarketplace(run, name), '--json']);
}

export async function upgradeCodexMarketplace(run: PluginCliRun, name: string): Promise<string> {
  return act(run, ['marketplace', 'upgrade', await requireMarketplace(run, name), '--json']);
}
