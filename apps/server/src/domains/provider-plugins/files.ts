import { existsSync, statSync } from 'node:fs';
import type {
  ProviderPluginFile,
  ProviderPluginFileContent,
  ProviderPluginFileDraft,
  ProviderPluginsInfo,
} from '@claude-control/contracts';
import { backupEntry, removeEntry, readTextFile, writeTextFile } from '../../lib/safe-io.ts';
import { SECTION_MAX_FILE_BYTES, fileSizeOf, walkSectionFiles } from '../../lib/section-fs.ts';
import {
  PluginFileNotEditableError,
  PluginFileNotFoundError,
  UnsafePluginPathError,
} from './errors.ts';
import { hasPluginExtension, pluginBackupName, resolvePluginPath, toRelative } from './paths.ts';
import type { ProviderPluginsTarget } from './types.ts';

/** Половина сводки, отвечающая за файлы каталога. */
type PluginFilesSection = Pick<ProviderPluginsInfo, 'files' | 'ignored' | 'filesReadOnly'> &
  Partial<Pick<ProviderPluginsInfo, 'filesError'>>;

function describe(target: ProviderPluginsTarget, fullPath: string): ProviderPluginFile {
  return { path: toRelative(target, fullPath), fullPath, size: fileSizeOf(fullPath) };
}

/**
 * Файлы каталога плагинов: с известным расширением — плагины, остальное —
 * прочее. Каталог не читается (права, гонка с удалением) — половина уходит на
 * чтение, но не на запись.
 */
export function readPluginFilesSection(
  target: ProviderPluginsTarget,
  dirExists: boolean,
): PluginFilesSection {
  if (!dirExists) return { files: [], ignored: [], filesReadOnly: false };

  try {
    const walked = walkSectionFiles(target.pluginsDir, (name) => Boolean(hasPluginExtension(name)));
    return {
      files: walked.own
        .map((full) => describe(target, full))
        .sort((a, b) => a.path.localeCompare(b.path)),
      ignored: walked.other
        .map((full) => describe(target, full))
        .sort((a, b) => a.path.localeCompare(b.path)),
      filesReadOnly: false,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      files: [],
      ignored: [],
      filesReadOnly: true,
      ...(message ? { filesError: message } : {}),
    };
  }
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
  if (fileSizeOf(fullPath) > SECTION_MAX_FILE_BYTES) {
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
