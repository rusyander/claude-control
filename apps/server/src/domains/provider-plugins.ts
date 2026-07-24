import { existsSync, lstatSync, readdirSync, statSync } from 'node:fs';
import { basename, join, relative, sep } from 'node:path';
import type {
  AppSettings,
  ProviderPluginFile,
  ProviderPluginFileContent,
  ProviderPluginFileDraft,
  ProviderPluginsInfo,
  ProviderPluginsScope,
} from '@claude-control/contracts';
import { getActiveProvider } from '../providers/registry.ts';
import type { ConfigProvider } from '../providers/types.ts';
import { backupEntry, removeEntry, readTextFile, writeTextFile } from '../lib/safe-io.ts';
import { UnrecognizedFormatError } from '../lib/codex-toml.ts';
import { parseProviderJsonObject, stableJson } from '../lib/provider-json.ts';
import {
  applyOpencodePlugins,
  isOpencodePluginPackage,
  readOpencodePlugins,
} from '../lib/opencode-plugin.ts';

/**
 * Раздел «Плагины» у НЕ-Claude провайдера (OPENCODE-4).
 *
 * Раздел «Плагины» Claude — это каталог расширений САМОЙ панели (`domains/
 * plugins.ts`, маршруты `/api/plugins`). Он не меняется: здесь речь о плагинах
 * чужого CLI, и модель другая.
 *
 * У OpenCode плагины подключаются ДВУМЯ задокументированными способами, и панель
 * ведёт оба:
 *
 *  1. **ФАЙЛЫ ПЛАГИНОВ** — модули JS/TS, которые OpenCode подхватывает при старте
 *     из каталога `~/.config/opencode/plugins/` (глобально) и
 *     `<проект>/.opencode/plugins/` (в проекте). Это тот же случай, что каталог
 *     правил Cursor (CURSOR-1), поэтому менеджер списан с него один-в-один,
 *     ВКЛЮЧАЯ защиту путей.
 *  2. **NPM-ПАКЕТЫ** — массив `plugin` в `opencode.json`. Ключ подтверждён
 *     документацией и опубликованной схемой конфигурации (см. `lib/
 *     opencode-plugin.ts`), поэтому список читается И правится.
 *
 * БЕЗОПАСНОСТЬ ПУТЕЙ — как у правил Cursor. Клиент присылает путь ОТНОСИТЕЛЬНО
 * каталога плагинов, и он обязан разрешаться ВНУТРИ него. Отклоняются: пустое
 * имя, `..`/`.`/пустой сегмент, абсолютный путь (в т.ч. `C:\…` и `\\сервер\шара`),
 * нулевой байт, расширение не из белого списка, а также путь, любой сегмент
 * которого — символическая ссылка. Отказ = 400 `unsafe_path` ВСЕГДА, никогда 404:
 * существует ли файл за пределами каталога — не наше дело сообщать. Одинаково на
 * чтении, записи и удалении.
 *
 * FAIL-CLOSED: каталог не читается → файловая половина только для чтения; конфиг
 * не разбирается → список npm только для чтения (422 на запись), файл не тронут.
 * Каталог создаётся ТОЛЬКО при явном сохранении файла.
 */

/** Минимум настроек, нужный резолверу (без импорта AppStore). */
interface ProviderPluginsSettingsSource {
  getSettings(): Pick<AppSettings, 'provider' | 'claudeDirOverride'>;
}

/**
 * Расширения файлов-плагинов, которые OpenCode загружает («JavaScript or
 * TypeScript files»). `.mjs` включён как обычная форма ES-модуля JS.
 * Списка «на глаз» не расширяем: чего нет в документации, того панель не пишет.
 */
export const OPENCODE_PLUGIN_EXTENSIONS = ['.js', '.ts', '.mjs'] as const;

/** Разрешённая цель раздела: провайдер + каталог файлов + конфиг npm-списка. */
export interface ProviderPluginsTarget {
  provider: ConfigProvider;
  format: 'opencode-plugins';
  scope: ProviderPluginsScope;
  /** Абсолютный путь каталога файлов-плагинов. */
  pluginsDir: string;
  /** Абсолютный путь конфигурации с массивом `plugin`. */
  configPath: string;
  /** Префикс имени резервной копии: `<id>-` глобально, `<id>-project-` в проекте. */
  backupPrefix: string;
}

/** Путь файла плагина выходит за пределы каталога — операция запрещена. */
export class UnsafePluginPathError extends Error {
  readonly path: string;

  constructor(path: string, detail: string) {
    super(`Путь плагина «${path}» отклонён: ${detail}`);
    this.name = 'UnsafePluginPathError';
    this.path = path;
  }
}

/** Файла плагина с таким путём в каталоге нет. */
export class PluginFileNotFoundError extends Error {
  readonly path: string;

  constructor(path: string) {
    super(`Файл плагина «${path}» не найден в каталоге плагинов.`);
    this.name = 'PluginFileNotFoundError';
    this.path = path;
  }
}

/** Файл есть, но панель его не открывает (слишком большой, не текст). */
export class PluginFileNotEditableError extends Error {
  readonly path: string;

  constructor(path: string, message: string) {
    super(message);
    this.name = 'PluginFileNotEditableError';
    this.path = path;
  }
}

/**
 * Разложить отказ домена в код ответа и тело — одинаково для глобального и
 * проектного маршрутов. `undefined` для ошибок, которые маршрут пробрасывает.
 *
 * Небезопасный путь — всегда 400 `unsafe_path`, НИКОГДА 404.
 */
export function describePluginError(
  error: unknown,
): { status: number; body: Record<string, unknown> } | undefined {
  if (error instanceof UnsafePluginPathError) {
    return { status: 400, body: { error: 'unsafe_path', message: error.message } };
  }
  if (error instanceof PluginFileNotFoundError) {
    return { status: 404, body: { error: 'not_found', message: error.message } };
  }
  if (error instanceof PluginFileNotEditableError) {
    return { status: 422, body: { error: 'plugin_read_only', message: error.message } };
  }
  return undefined;
}

/** Больше этого панель не открывает: раздел — редактор плагинов, а не просмотр дампов. */
const MAX_PLUGIN_BYTES = 1_000_000;

/** Предохранители обхода каталога: он пользовательский, глубина и размер не наши. */
const MAX_DEPTH = 8;
const MAX_ENTRIES = 2000;

/**
 * Цель глобального раздела плагинов — или `undefined`, если активный провайдер
 * его не поддерживает (маршрут ответит 4xx). Поддержан, только когда `plugins` =
 * `ready` И задан `pluginsConfig`. Claude сюда не попадает.
 */
export function resolveProviderPluginsTarget(
  store: ProviderPluginsSettingsSource,
): ProviderPluginsTarget | undefined {
  const provider = getActiveProvider(store);
  if (provider.capabilities.plugins !== 'ready' || !provider.pluginsConfig) return undefined;

  const override = store.getSettings().claudeDirOverride;
  return {
    provider,
    format: provider.pluginsConfig.format,
    scope: 'global',
    pluginsDir: provider.pluginsConfig.dir(override),
    configPath: provider.pluginsConfig.configPath(override),
    backupPrefix: `${provider.id}-`,
  };
}

// --- Безопасность путей ------------------------------------------------------

/** Абсолютный ли путь по любым правилам (POSIX, Windows-диск, UNC). */
function looksAbsolute(value: string): boolean {
  return /^([/\\]|[A-Za-z]:)/.test(value);
}

/** Расширение файла из белого списка (сравнение без учёта регистра). */
function hasPluginExtension(name: string): string | undefined {
  const lower = name.toLowerCase();
  return OPENCODE_PLUGIN_EXTENSIONS.find(
    (extension) => lower.endsWith(extension) && lower.length > extension.length,
  );
}

/**
 * Разрешить относительный путь файла плагина ВНУТРИ каталога плагинов.
 *
 * Отклоняем: пустое имя, абсолютный путь, нулевой байт, `..`/`.`/пустой сегмент,
 * расширение не из белого списка, выход за каталог по итоговому пути и
 * символическую ссылку в любом сегменте.
 */
export function resolvePluginPath(target: ProviderPluginsTarget, rawPath: string): string {
  const value = String(rawPath ?? '').trim();
  if (!value) throw new UnsafePluginPathError(rawPath, 'пустое имя.');
  if (looksAbsolute(value)) throw new UnsafePluginPathError(value, 'абсолютные пути запрещены.');
  if (value.includes('\0')) throw new UnsafePluginPathError(value, 'недопустимый символ.');

  // Разделители НЕ схлопываем: `sub//plugin.ts` даёт пустой сегмент и отклоняется.
  const segments = value.split(/[/\\]/);
  for (const segment of segments) {
    if (!segment || segment === '.' || segment === '..') {
      throw new UnsafePluginPathError(value, 'сегменты «.», «..» и пустые запрещены.');
    }
  }

  const name = segments[segments.length - 1]!;
  if (!hasPluginExtension(name)) {
    throw new UnsafePluginPathError(
      value,
      `файл плагина обязан оканчиваться на ${OPENCODE_PLUGIN_EXTENSIONS.join(', ')}.`,
    );
  }

  const fullPath = join(target.pluginsDir, ...segments);
  // Контрольная проверка после сборки: наружу каталога путь уйти не должен.
  const rel = relative(target.pluginsDir, fullPath);
  if (!rel || rel.startsWith('..') || looksAbsolute(rel)) {
    throw new UnsafePluginPathError(value, 'путь выходит за пределы каталога плагинов.');
  }

  assertNoSymlinkEscape(target.pluginsDir, fullPath, value);
  return fullPath;
}

/**
 * Ни один сегмент между каталогом плагинов и целью не должен быть символической
 * ссылкой: через неё запись/удаление ушли бы наружу каталога. Сам каталог
 * плагинов ссылкой быть может — это выбор пользователя и корень доверия.
 */
function assertNoSymlinkEscape(pluginsDir: string, fullPath: string, shown: string): void {
  let current = pluginsDir;
  for (const segment of relative(pluginsDir, fullPath).split(sep)) {
    current = join(current, segment);
    let stat;
    try {
      stat = lstatSync(current);
    } catch {
      return; // дальше по пути ничего не существует — подменять нечего
    }
    if (stat.isSymbolicLink()) {
      throw new UnsafePluginPathError(shown, 'на пути есть символическая ссылка.');
    }
  }
}

/** Путь относительно каталога плагинов в клиентской форме (разделитель `/`). */
function toRelative(target: ProviderPluginsTarget, fullPath: string): string {
  return relative(target.pluginsDir, fullPath).split(sep).join('/');
}

// --- Чтение каталога ---------------------------------------------------------

/** Все файлы каталога: с известным расширением — плагины, остальное — прочее. */
function walkPluginsDir(target: ProviderPluginsTarget): { files: string[]; ignored: string[] } {
  const files: string[] = [];
  const ignored: string[] = [];
  let seen = 0;

  const visit = (dir: string, depth: number): void => {
    if (depth > MAX_DEPTH || seen >= MAX_ENTRIES) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (seen >= MAX_ENTRIES) return;
      const full = join(dir, entry.name);
      // Символические ссылки не обходим вовсе: они могут вести наружу каталога.
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        visit(full, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      seen += 1;
      if (hasPluginExtension(entry.name)) files.push(full);
      else ignored.push(full);
    }
  };

  visit(target.pluginsDir, 0);
  return { files, ignored };
}

/** Размер файла в байтах; недоступен → 0 (лишь витрина, не решение о записи). */
function sizeOf(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

function describe(target: ProviderPluginsTarget, fullPath: string): ProviderPluginFile {
  return { path: toRelative(target, fullPath), fullPath, size: sizeOf(fullPath) };
}

/** Форма файла OpenCode: правится ТОЛЬКО ключ `plugin`, прочее — как есть. */
interface RawOpencodeConfig {
  plugin?: unknown;
  [key: string]: unknown;
}

/**
 * Сводка раздела: файлы каталога + список npm-пакетов. Половины независимы:
 * сломанный конфиг не мешает управлять файлами, и наоборот.
 */
export function readProviderPluginsInfo(target: ProviderPluginsTarget): ProviderPluginsInfo {
  const base = {
    providerId: target.provider.id,
    providerName: target.provider.name,
    format: target.format,
    scope: target.scope,
    pluginsDir: target.pluginsDir,
    dirExists: existsSync(target.pluginsDir),
    configPath: target.configPath,
  };

  // --- половина 1: файлы каталога
  let files: ProviderPluginFile[] = [];
  let ignored: ProviderPluginFile[] = [];
  let filesReadOnly = false;
  let filesError: string | undefined;

  if (base.dirExists) {
    try {
      const walked = walkPluginsDir(target);
      files = walked.files
        .map((full) => describe(target, full))
        .sort((a, b) => a.path.localeCompare(b.path));
      ignored = walked.ignored
        .map((full) => describe(target, full))
        .sort((a, b) => a.path.localeCompare(b.path));
    } catch (error) {
      // Каталог не читается (права, гонка с удалением) — на чтение, но не на запись.
      filesReadOnly = true;
      filesError = error instanceof Error ? error.message : String(error);
    }
  }

  // --- половина 2: массив `plugin` в конфиге
  const text = readTextFile(target.configPath);
  let packagesPresent = false;
  let packages: string[] = [];
  let preservedPackages: ProviderPluginsInfo['preservedPackages'] = [];
  let packagesReadOnly = false;
  let packagesError: string | undefined;

  if (text.trim()) {
    try {
      const config = parseProviderJsonObject<RawOpencodeConfig>(text);
      const state = readOpencodePlugins(config.plugin);
      packagesPresent = state.present;
      packages = state.packages;
      preservedPackages = state.preserved;
    } catch (error) {
      packagesReadOnly = true;
      packagesError = error instanceof Error ? error.message : String(error);
    }
  }

  return {
    ...base,
    files,
    ignored,
    filesReadOnly,
    ...(filesError ? { filesError } : {}),
    packagesPresent,
    packages,
    preservedPackages,
    packagesReadOnly,
    ...(packagesError ? { packagesError } : {}),
  };
}

/**
 * Прочитать ОДИН файл плагина. Содержимое отдаётся как есть — панель его ничем
 * не разбирает: это исходник модуля, а не конфиг известной формы.
 */
export function readProviderPluginFile(
  target: ProviderPluginsTarget,
  rawPath: string,
): ProviderPluginFileContent {
  const fullPath = resolvePluginPath(target, rawPath);
  if (!existsSync(fullPath) || !statSync(fullPath).isFile()) {
    throw new PluginFileNotFoundError(rawPath);
  }
  if (sizeOf(fullPath) > MAX_PLUGIN_BYTES) {
    throw new PluginFileNotEditableError(
      rawPath,
      `Файл ${fullPath} слишком большой для правки в панели.`,
    );
  }

  const content = readTextFile(fullPath);
  // Нулевой байт означает, что под известным расширением лежит не текст —
  // показывать и тем более переписывать такое панель не станет.
  if (content.includes('\0')) {
    throw new PluginFileNotEditableError(rawPath, `Файл ${fullPath} не является текстовым.`);
  }

  return { path: toRelative(target, fullPath), fullPath, content };
}

/**
 * Разобрать черновик файла плагина. Схему zod в рантайме сервера использовать
 * нельзя — проверяем руками. Некорректное тело → `undefined` (маршрут 400).
 */
export function parseProviderPluginFileDraft(body: unknown): ProviderPluginFileDraft | undefined {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return undefined;
  const raw = body as Record<string, unknown>;

  if (typeof raw.path !== 'string' || !raw.path.trim()) return undefined;
  // Пустое содержимое допустимо (заготовка файла), отсутствие поля — нет.
  if (typeof raw.content !== 'string') return undefined;
  if (raw.content.includes('\0')) return undefined;

  return { path: raw.path, content: raw.content };
}

/** Имя резервной копии файла плагина: `<id>[-project-]<путь с «-» вместо «/»>`. */
function pluginBackupName(target: ProviderPluginsTarget, fullPath: string): string {
  return `${target.backupPrefix}${toRelative(target, fullPath).split('/').join('-')}`;
}

/**
 * Создать или обновить файл плагина: бэкап + атомарная запись + сохранение формы
 * файла (BOM/CRLF). Подкаталоги создаются ТОЛЬКО здесь — при явном сохранении по
 * такому пути; сам каталог плагинов тоже.
 */
export function saveProviderPluginFile(
  target: ProviderPluginsTarget,
  draft: ProviderPluginFileDraft,
  backupDir: string | undefined,
): { path: string; fullPath: string; backupPath?: string } {
  const fullPath = resolvePluginPath(target, draft.path);
  if (existsSync(fullPath) && !statSync(fullPath).isFile()) {
    throw new UnsafePluginPathError(draft.path, 'по этому пути находится каталог, а не файл.');
  }

  const backupPath = writeTextFile(fullPath, draft.content, {
    backupDir,
    backupName: pluginBackupName(target, fullPath),
  });

  return { path: toRelative(target, fullPath), fullPath, ...(backupPath ? { backupPath } : {}) };
}

/**
 * Удалить файл плагина: сначала резервная копия, потом удаление. Защита пути
 * ровно та же, что при записи. Опустевшие подкаталоги НЕ удаляем.
 */
export function deleteProviderPluginFile(
  target: ProviderPluginsTarget,
  rawPath: string,
  backupDir: string | undefined,
): { path: string; backupPath?: string } {
  const fullPath = resolvePluginPath(target, rawPath);
  if (!existsSync(fullPath) || !statSync(fullPath).isFile()) {
    throw new PluginFileNotFoundError(rawPath);
  }

  const backupPath = backupDir
    ? backupEntry(fullPath, backupDir, pluginBackupName(target, fullPath))
    : undefined;
  removeEntry(fullPath);

  return { path: toRelative(target, fullPath), ...(backupPath ? { backupPath } : {}) };
}

// --- npm-список (`plugin` в opencode.json) ------------------------------------

/**
 * Разобрать черновик списка npm-плагинов. Отклоняем: не массив, не строки, имя с
 * пробелом/кавычкой/пустое, дубликаты (в файле они молча остались бы обоими и
 * запутали бы пользователя).
 */
export function parseProviderPluginPackagesDraft(body: unknown): string[] | undefined {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return undefined;
  const raw = (body as Record<string, unknown>).packages;
  if (!Array.isArray(raw) || raw.length > 200) return undefined;

  const seen = new Set<string>();
  const packages: string[] = [];
  for (const item of raw) {
    if (!isOpencodePluginPackage(item)) return undefined;
    if (seen.has(item)) return undefined;
    seen.add(item);
    packages.push(item);
  }
  return packages;
}

/**
 * Проекция «всё, кроме ведомых панелью строковых записей `plugin`». По ней
 * результат сверяется с оригиналом: изменился любой чужой ключ файла или любая
 * запись расширенной формы — запись отменяется.
 */
function otherKeysProjection(config: RawOpencodeConfig): string {
  const rest: Record<string, unknown> = { ...config };

  if (Array.isArray(config.plugin)) {
    const kept = config.plugin.filter((item) => !(typeof item === 'string' && item.trim()));
    if (kept.length > 0) rest.plugin = kept;
    else delete rest.plugin;
  }

  return stableJson(rest);
}

/**
 * Записать список npm-плагинов, поменяв ТОЛЬКО ключ `plugin`. Записи расширенной
 * формы сохраняются, пустой результат УДАЛЯЕТ ключ (а не пишет `[]`). Файл не
 * разбирается → `UnrecognizedFormatError` (маршрут 422, файл не тронут).
 */
export function saveProviderPluginPackages(
  target: ProviderPluginsTarget,
  packages: string[],
  backupDir: string | undefined,
): string | undefined {
  // Двойная страховка: даже если сюда попало кривое имя, в файл оно не уйдёт.
  for (const name of packages) {
    if (!isOpencodePluginPackage(name)) throw new UnrecognizedFormatError();
  }

  const text = readTextFile(target.configPath);
  const original: RawOpencodeConfig = text.trim()
    ? parseProviderJsonObject<RawOpencodeConfig>(text)
    : {};
  // Второй разбор — рабочее дерево (первый остаётся эталоном «как было»).
  const config: RawOpencodeConfig = text.trim()
    ? parseProviderJsonObject<RawOpencodeConfig>(text)
    : {};

  const next = applyOpencodePlugins(config.plugin, packages);
  if (next) config.plugin = next;
  else delete config.plugin;

  const serialized = `${JSON.stringify(config, null, 2)}\n`;

  // Контроль ДО записи: итог разбирается, список совпал с намерением, прочие
  // ключи файла и записи расширенной формы целы.
  const parsed = parseProviderJsonObject<RawOpencodeConfig>(serialized);
  const check = readOpencodePlugins(parsed.plugin);
  if (stableJson(check.packages) !== stableJson(packages)) throw new UnrecognizedFormatError();
  if (otherKeysProjection(original) !== otherKeysProjection(parsed)) {
    throw new UnrecognizedFormatError();
  }

  return writeTextFile(target.configPath, serialized, {
    backupDir,
    backupName: `${target.backupPrefix}${basename(target.configPath)}`,
  });
}
