import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { ProviderInstalledPlugin, ProviderPluginsInfo } from '@agentdeck/contracts';
import { readTextFile } from '../../lib/safe-io/safe-io.ts';
import { parseProviderJsonObject } from '../../lib/provider-json.ts';
import {
  QWEN_ACTION_TIMEOUT_MS,
  QWEN_LIST_TIMEOUT_MS,
  cliTail,
  serializeQwenAction,
  type QwenCliResult,
  type QwenCliRun,
} from './plugin-cli.ts';
import {
  InvalidExtensionSourceError,
  QwenCliFailedError,
  QwenCliUnavailableError,
  QwenExtensionNotFoundError,
} from './errors.ts';
import type { ProviderPluginsTarget } from './types.ts';

/**
 * Расширения Qwen Code (MAP 25): `<QWEN_HOME>/extensions/<имя>/qwen-extension.json`.
 *
 * ЧИТАЕТ панель сама — манифест и метаданные установки
 * (`.qwen-extension-install.json`: `{source, type}`) лежат открыто. Признак
 * «включено» — только словами CLI (`qwen extensions list`, отметка ✓/✗): файл
 * `extension-enablement.json` хранит шаблоны путей, и пересчитывать их за CLI
 * значило бы угадывать его правило. МЕНЯЕТ — только CLI (`plugin-cli.ts`).
 */

const MANIFEST = 'qwen-extension.json';
const INSTALL_META = '.qwen-extension-install.json';
/** Контекст по умолчанию, когда манифест не называет `contextFileName`. */
const DEFAULT_CONTEXT = 'QWEN.md';
/** Потолок длины источника: путь, адрес git, `owner/repo`, пакет npm. */
const MAX_SOURCE_LENGTH = 1000;
// Управляющие символы (включая перевод строки) в источнике недопустимы.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

const asString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value : undefined;

/** `description`/`displayName` бывают строкой или `{en, zh}` — берём английский. */
function localized(value: unknown): string | undefined {
  if (asString(value)) return asString(value);
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  return asString(record.en) ?? Object.values(record).map(asString).find(Boolean);
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function readJson(path: string): Record<string, unknown> {
  return parseProviderJsonObject<Record<string, unknown>>(readTextFile(path));
}

/** Метаданные установки — по ним видно источник; у ссылки (`link`) манифест там же. */
function readInstallMeta(root: string): { source?: string; type?: string } {
  const path = join(root, INSTALL_META);
  if (!existsSync(path)) return {};
  try {
    const raw = readJson(path);
    return { source: asString(raw.source), type: asString(raw.type) };
  } catch {
    return {};
  }
}

function contextFilesOf(raw: Record<string, unknown>, root: string): string[] {
  const named = raw.contextFileName;
  if (typeof named === 'string' && named.trim()) return [named];
  if (Array.isArray(named)) return named.filter((name): name is string => Boolean(asString(name)));
  return existsSync(join(root, DEFAULT_CONTEXT)) ? [DEFAULT_CONTEXT] : [];
}

function brokenExtension(id: string, manifestPath: string, error: string): ProviderInstalledPlugin {
  return {
    id,
    manifestPath,
    hasSkills: false,
    mcpServers: [],
    hookCount: 0,
    hasCommands: false,
    error,
  };
}

/** Одно расширение каталога. Нет манифеста или он не разобран → строка с `error`. */
function readExtension(extensionsDir: string, id: string): ProviderInstalledPlugin {
  const root = join(extensionsDir, id);
  const meta = readInstallMeta(root);
  // Связанное (`qwen extensions link`) расширение живёт у источника.
  const contentRoot =
    meta.type === 'link' && meta.source && isDir(meta.source) ? meta.source : root;
  const manifestPath = join(contentRoot, MANIFEST);
  const sourceFields = {
    ...(meta.source ? { source: meta.source } : {}),
    ...(meta.type ? { sourceType: meta.type } : {}),
  };
  if (!existsSync(manifestPath)) {
    return {
      ...brokenExtension(id, root, 'Манифест qwen-extension.json не найден.'),
      ...sourceFields,
    };
  }

  try {
    const raw = readJson(manifestPath);
    const servers = raw.mcpServers;
    return {
      id,
      manifestPath,
      ...(asString(raw.name) ? { name: asString(raw.name)! } : {}),
      ...(asString(raw.version) ? { version: asString(raw.version)! } : {}),
      ...(localized(raw.description) ? { description: localized(raw.description)! } : {}),
      ...(localized(raw.displayName) ? { displayName: localized(raw.displayName)! } : {}),
      hasSkills: isDir(join(contentRoot, 'skills')),
      mcpServers:
        servers && typeof servers === 'object' && !Array.isArray(servers)
          ? Object.keys(servers as Record<string, unknown>)
          : [],
      hookCount: 0,
      hasCommands: isDir(join(contentRoot, 'commands')),
      hasAgents: isDir(join(contentRoot, 'agents')),
      contextFiles: contextFilesOf(raw, contentRoot),
      ...sourceFields,
    };
  } catch (error) {
    return {
      ...brokenExtension(id, manifestPath, error instanceof Error ? error.message : String(error)),
      ...sourceFields,
    };
  }
}

/** Все расширения каталога, по имени. Служебные файлы CLI (`*.json`) — не расширения. */
export function readQwenExtensions(extensionsDir: string): ProviderInstalledPlugin[] {
  if (!existsSync(extensionsDir)) return [];
  return readdirSync(extensionsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => readExtension(extensionsDir, entry.name))
    .sort((a, b) => a.id.localeCompare(b.id));
}

const normalize = (path: string): string =>
  path.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

/**
 * Отметки ✓/✗ из `qwen extensions list`. Вывод без JSON и переведён на язык
 * системы, поэтому опора — только непереводимое: отметка в начале блока и
 * строка, оканчивающаяся путём каталога расширения. Имя из заголовка — запасной
 * ключ, если строки пути не нашлось.
 */
export function parseQwenExtensionsList(
  stdout: string,
  extensionsDir: string,
  installed: readonly ProviderInstalledPlugin[],
): Map<string, boolean> {
  const states = new Map<string, boolean>();
  const blocks: { enabled: boolean; name?: string; lines: string[] }[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const header = /^([✓✗])\s+(\S+)/u.exec(line);
    if (header) {
      blocks.push({ enabled: header[1] === '✓', name: header[2], lines: [] });
    } else {
      blocks.at(-1)?.lines.push(normalize(line.trim()));
    }
  }

  const base = normalize(extensionsDir);
  for (const block of blocks) {
    const byPath = installed.find((plugin) =>
      block.lines.some((line) => line.endsWith(`${base}/${plugin.id.toLowerCase()}`)),
    );
    const plugin = byPath ?? installed.find((item) => (item.name ?? item.id) === block.name);
    if (plugin) states.set(plugin.id, block.enabled);
  }
  return states;
}

/** Сводка раздела без запуска CLI: манифесты, признак «включено» не известен. */
export function readQwenExtensionsInfo(
  target: ProviderPluginsTarget,
  base: Pick<
    ProviderPluginsInfo,
    'providerId' | 'providerName' | 'format' | 'scope' | 'pluginsDir' | 'dirExists'
  >,
): ProviderPluginsInfo {
  let installed: ProviderInstalledPlugin[] = [];
  let installedError: string | undefined;
  try {
    installed = readQwenExtensions(target.pluginsDir);
  } catch (error) {
    installedError = error instanceof Error ? error.message : String(error);
  }

  return {
    ...base,
    sections: ['installed'],
    files: [],
    ignored: [],
    filesReadOnly: true,
    packagesPresent: false,
    packages: [],
    preservedPackages: [],
    packagesReadOnly: true,
    installed,
    installedActions: true,
    available: [],
    marketplaces: [],
    marketplaceActions: false,
    ...(installedError ? { installedError } : {}),
  };
}

function describeFailure(result: QwenCliResult): string {
  if (result.spawnError) return result.spawnError;
  if (result.timedOut) return 'CLI не ответил вовремя и был остановлен.';
  return cliTail(result) || `код выхода ${result.code}`;
}

/** Дополнить сводку отметками ✓/✗. CLI не ответил — причина в `installedStateError`. */
export async function withQwenEnabledState(
  info: ProviderPluginsInfo,
  run: QwenCliRun,
): Promise<ProviderPluginsInfo> {
  if (info.installed.length === 0) return info;
  const result = await run(['list'], QWEN_LIST_TIMEOUT_MS);
  if (result.spawnError || result.timedOut || result.code !== 0) {
    return { ...info, installedStateError: describeFailure(result) };
  }
  const states = parseQwenExtensionsList(result.stdout, info.pluginsDir, info.installed);
  return {
    ...info,
    installed: info.installed.map((plugin) =>
      states.has(plugin.id) ? { ...plugin, enabled: states.get(plugin.id)! } : plugin,
    ),
  };
}

/** Источник установки: одна строка, без флага в начале, разумной длины. */
export function parseExtensionSource(raw: unknown): string {
  const source = typeof raw === 'string' ? raw.trim() : '';
  if (
    !source ||
    source.length > MAX_SOURCE_LENGTH ||
    CONTROL_CHARS.test(source) ||
    source.startsWith('-')
  ) {
    throw new InvalidExtensionSourceError();
  }
  return source;
}

/** Имя для команд CLI — только имя установленного расширения. */
function requireInstalledName(target: ProviderPluginsTarget, name: string): string {
  const found = readQwenExtensions(target.pluginsDir).find(
    (plugin) => (plugin.name ?? plugin.id) === name,
  );
  if (!found) throw new QwenExtensionNotFoundError(name);
  return found.name ?? found.id;
}

/** Запустить действие по очереди; отказ CLI — исключение с его же словами. */
async function act(run: QwenCliRun, args: string[]): Promise<string> {
  const result = await serializeQwenAction(() => run(args, QWEN_ACTION_TIMEOUT_MS));
  if (result.spawnError) throw new QwenCliUnavailableError(result.spawnError);
  if (result.timedOut || result.code !== 0) throw new QwenCliFailedError(describeFailure(result));
  return cliTail(result, 3);
}

export function installQwenExtension(run: QwenCliRun, source: string): Promise<string> {
  return act(run, ['install', '--consent', source]);
}

export async function setQwenExtensionEnabled(
  target: ProviderPluginsTarget,
  run: QwenCliRun,
  name: string,
  enabled: boolean,
): Promise<string> {
  const known = requireInstalledName(target, name);
  return act(run, [enabled ? 'enable' : 'disable', '--scope', 'user', known]);
}

export async function uninstallQwenExtension(
  target: ProviderPluginsTarget,
  run: QwenCliRun,
  name: string,
): Promise<string> {
  const known = requireInstalledName(target, name);
  return act(run, ['uninstall', known]);
}
