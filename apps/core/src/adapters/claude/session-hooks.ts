import { existsSync, readFileSync } from 'node:fs';
import { basename, isAbsolute, join, resolve } from 'node:path';
import type { SettingSource } from '@agentdeck/contracts/core/session-carry';
import type { InventorySession } from '../adapter.types.ts';
import { readSource, type Source, type Unread } from '../layer-inventory.ts';
import {
  claudeConfigDir,
  keyedHooks,
  readUserLayer,
  userLayerFiles,
  type HookGroup,
  type HookTable,
  type LayerFile,
  type ObservedHook,
} from './user-layer.ts';

/**
 * Хуки, которые Claude Code исполняет в сеансе ядра (06:121-122, R2), — не только файлы настроек
 * человека. CLI берёт хуки ещё из каждого `--plugin-dir` (набор панели и стражи набора —
 * `carry.plugins`, плагин локального слоя), из `--settings` ядра (хуки локального слоя) и из
 * плагинов, включённых `enabledPlugins` в загруженных источниках настроек (реестр
 * `plugins/installed_plugins.json` каталога настроек). Опись без них не называла отказ стража
 * набора (`agent-prompt-guard`): «кандидатов по matcher нет».
 *
 * Ключи: файлы настроек — `<событие>.<группа>.<хук>` (тот же ключ у записи `observe`), плагин —
 * `<имя плагина>:<событие>.<группа>.<хук>`, хуки локального слоя — `local-layer:…`.
 */

/** Откуда хук: файлы настроек человека, плагин, перенос сеанса (`--settings` ядра). */
export type HookOrigin = 'settings' | 'plugin' | 'carry';

export interface SessionHook extends ObservedHook {
  origin: HookOrigin;
  /** Корень плагина: CLI подставляет его вместо `${CLAUDE_PLUGIN_ROOT}` в команде. */
  pluginRoot?: string;
}

export interface ClaudeSessionHooks {
  hooks: SessionHook[];
  /** Файлы хуков плагинов — источники описи (входят в её хеш). */
  sources: Source[];
  unread: Unread[];
}

const MANIFEST = join('.claude-plugin', 'plugin.json');
const DEFAULT_HOOKS = join('hooks', 'hooks.json');
const REGISTRY = join('plugins', 'installed_plugins.json');
const REGISTRY_VERSION = 2;
const LOCAL_SETTINGS = 'settings.local.json';
const LOCAL_LAYER_KEY = 'local-layer';
const LOCAL_LAYER_SOURCE = 'session carry: localLayer.hooks';
const ALL_SOURCES: readonly SettingSource[] = ['user', 'project', 'local'];
const BOM = new RegExp(`^${String.fromCharCode(0xfeff)}`);

type Json = Record<string, unknown>;
const isRecord = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function readJson(path: string): { value: unknown } | { unread: string } | null {
  if (!existsSync(path)) return null;
  try {
    return { value: JSON.parse(readFileSync(path, 'utf8')) as unknown };
  } catch (error) {
    return { unread: (error as Error).message };
  }
}

/** Источник настроек файла слоя: `settings.local.json` проекта — `local`. */
const sourceOf = (file: LayerFile): SettingSource =>
  file.source === 'user' ? 'user' : basename(file.path) === LOCAL_SETTINGS ? 'local' : 'project';

/** Источники, которые CLI грузит в `on`: песочница — только `user`, перенос сужает списком. */
function loadedSources(session: InventorySession): ReadonlySet<SettingSource> {
  if (session.sources === 'user') return new Set(['user']);
  return new Set(session.carry?.settingSources ?? ALL_SOURCES);
}

/** Таблица хуков из разобранного JSON: группы без массива `hooks` — не хуки (как у настроек). */
function tableOf(raw: unknown): HookTable {
  const table: HookTable = {};
  if (!isRecord(raw)) return table;
  for (const [event, groups] of Object.entries(raw)) {
    if (!Array.isArray(groups)) continue;
    table[event] = groups.filter(
      (g): g is HookGroup => isRecord(g) && Array.isArray((g as Json).hooks),
    );
  }
  return table;
}

function keyed(table: HookTable, file: string, prefix: string): ObservedHook[] {
  const hookFiles = Object.fromEntries(
    Object.entries(table).map(([event, groups]) => [event, groups.map(() => file)]),
  );
  return keyedHooks({ hooks: table, hookFiles }).map((h) => ({ ...h, key: `${prefix}:${h.key}` }));
}

/**
 * Хуки одного плагина: `hooks/hooks.json` и пути/объект `hooks` манифеста. Файл `hooks.json` —
 * `{hooks: {Событие: [группы]}}`; объект в манифесте — та же форма или сразу таблица.
 */
function pluginHooks(
  dir: string,
  scope: Source['scope'],
  out: ClaudeSessionHooks,
  seen: Set<string>,
): void {
  const root = resolve(dir);
  if (seen.has(root)) return;
  seen.add(root);
  const manifestPath = join(root, MANIFEST);
  const manifest = readJson(manifestPath);
  if (manifest && 'unread' in manifest)
    out.unread.push({ path: manifestPath, reason: manifest.unread });
  const doc = manifest && 'value' in manifest && isRecord(manifest.value) ? manifest.value : {};
  const name = typeof doc.name === 'string' && doc.name !== '' ? doc.name : basename(root);
  const files = [join(root, DEFAULT_HOOKS)];
  const declared = doc.hooks;
  for (const path of typeof declared === 'string'
    ? [declared]
    : Array.isArray(declared)
      ? declared
      : [])
    if (typeof path === 'string') files.push(isAbsolute(path) ? path : join(root, path));
  const tables: { table: HookTable; file: string }[] = [];
  for (const file of [...new Set(files.map((f) => resolve(f)))]) {
    const read = readSource(file);
    if (read === null) continue;
    if ('unread' in read) {
      out.unread.push({ path: file, reason: read.unread });
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(read.text.replace(BOM, ''));
    } catch {
      out.unread.push({ path: file, reason: 'not valid hooks JSON' });
      continue;
    }
    out.sources.push({ kind: 'hook', scope, path: file, sha256: read.sha256, bytes: read.bytes });
    tables.push({ table: tableOf(isRecord(parsed) ? parsed.hooks : undefined), file });
  }
  if (isRecord(declared)) {
    const inline = isRecord(declared.hooks) ? declared.hooks : declared;
    tables.push({ table: tableOf(inline), file: manifestPath });
  }
  // Одна нумерация групп на плагин: таблицы склеены по событию в порядке чтения.
  const merged: HookTable = {};
  const fileOf: Record<string, string[]> = {};
  for (const { table, file } of tables)
    for (const [event, groups] of Object.entries(table)) {
      (merged[event] ??= []).push(...groups);
      (fileOf[event] ??= []).push(...groups.map(() => file));
    }
  for (const hook of keyedHooks({ hooks: merged, hookFiles: fileOf }))
    out.hooks.push({ ...hook, key: `${name}:${hook.key}`, origin: 'plugin', pluginRoot: root });
}

/**
 * Плагины, включённые `enabledPlugins` загруженных файлов (поздний источник побеждает), — по
 * реестру установленного v2 каталога настроек. Реестр другой версии CLI не читает — и мы нет.
 */
function enabledPluginDirs(
  pin: Record<string, string>,
  files: readonly LayerFile[],
  out: ClaudeSessionHooks,
): { dir: string; scope: Source['scope'] }[] {
  const enabled = new Map<string, { on: boolean; scope: Source['scope'] }>();
  for (const file of files) {
    const read = readJson(file.path);
    if (!read || 'unread' in read || !isRecord(read.value)) continue;
    const plugins = read.value.enabledPlugins;
    if (!isRecord(plugins)) continue;
    for (const [id, on] of Object.entries(plugins))
      enabled.set(id, { on: on === true, scope: sourceOf(file) });
  }
  if (![...enabled.values()].some((e) => e.on)) return [];
  const registryPath = join(claudeConfigDir(pin), REGISTRY);
  const registry = readJson(registryPath);
  if (!registry) return [];
  if ('unread' in registry) {
    out.unread.push({ path: registryPath, reason: registry.unread });
    return [];
  }
  const doc = isRecord(registry.value) ? registry.value : {};
  if (doc.version !== REGISTRY_VERSION || !isRecord(doc.plugins)) {
    out.unread.push({
      path: registryPath,
      reason: `plugin registry version ${String(doc.version)}, expected ${REGISTRY_VERSION}`,
    });
    return [];
  }
  const dirs: { dir: string; scope: Source['scope'] }[] = [];
  for (const [id, state] of enabled) {
    if (!state.on) continue;
    const entries = doc.plugins[id];
    const first = Array.isArray(entries)
      ? entries.find((e): e is Json => isRecord(e) && typeof e.installPath === 'string')
      : undefined;
    if (first) dirs.push({ dir: first.installPath as string, scope: state.scope });
  }
  return dirs;
}

/**
 * Хуки сеанса. Без `session` — хуки файлов настроек человека, как прежде (оценка, ключ замера).
 * С `session`: в `on` файлы настроек — только загруженных источников, плюс включённые плагины;
 * в любом режиме — плагины переноса (`--plugin-dir` едет и в `observe` недоверия, `plugin-carry`)
 * и хуки локального слоя (`--settings` ядра).
 */
export function claudeSessionHooks(
  pin: Record<string, string>,
  cwd: string,
  repoLayer: boolean,
  session?: InventorySession,
): ClaudeSessionHooks {
  const out: ClaudeSessionHooks = { hooks: [], sources: [], unread: [] };
  const all = userLayerFiles(pin, cwd, repoLayer);
  const sources = session?.ran === 'on' ? loadedSources(session) : null;
  const loaded = sources ? all.filter((f) => sources.has(sourceOf(f))) : all;
  for (const hook of keyedHooks(readUserLayer(loaded)))
    out.hooks.push({ ...hook, origin: 'settings' });
  if (!session) return out;
  const local = session.carry?.localLayer;
  if (local?.hooks) {
    for (const hook of keyed(local.hooks as HookTable, LOCAL_LAYER_SOURCE, LOCAL_LAYER_KEY))
      out.hooks.push({ ...hook, origin: 'carry' });
  }
  const seen = new Set<string>();
  for (const dir of session.carry?.plugins ?? []) pluginHooks(dir, 'user', out, seen);
  if (local?.plugin) pluginHooks(local.plugin, 'local', out, seen);
  if (session.ran === 'on')
    for (const { dir, scope } of enabledPluginDirs(pin, loaded, out))
      pluginHooks(dir, scope, out, seen);
  return out;
}

/** Команды хука, как CLI может назвать их в отказе: как написана и с подставленным корнем плагина. */
export function hookCommands(hook: SessionHook): string[] {
  if (!hook.command) return [];
  const expanded = hook.pluginRoot
    ? hook.command.split('${CLAUDE_PLUGIN_ROOT}').join(hook.pluginRoot)
    : hook.command;
  return expanded === hook.command ? [hook.command] : [hook.command, expanded];
}
