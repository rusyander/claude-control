import { readdirSync, statSync, existsSync, mkdirSync, renameSync, readFileSync } from 'node:fs';
import { join, resolve, dirname, basename, sep } from 'node:path';
import type { ClaudeLocation } from '@claude-control/contracts';
import { writeTextFile, backupEntry, removeEntry } from '../../lib/safe-io.ts';
import { layoutOf, type ResourceKind } from './registry.ts';

/**
 * Работа с файлами любого ресурса: чтение дерева, содержимого, запись,
 * удаление и перенос. Различия между видами берутся из реестра, поэтому
 * здесь нет ни одного «если это скилл».
 */

/** Больше этого размера файл не отдаём: смотреть его в браузере всё равно нечем. */
const MAX_READABLE = 512 * 1024;

const BINARY_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.ico',
  '.pdf',
  '.zip',
  '.woff',
  '.woff2',
]);

export interface ResourceFile {
  /** Путь от корня ресурса. */
  path: string;
  sizeBytes: number;
  modifiedAt: string;
  /** Двоичные файлы показываем, но не даём править текстом. */
  isBinary: boolean;
}

export function rootOf(
  kind: ResourceKind,
  id: string,
  location: ClaudeLocation,
): string | undefined {
  return layoutOf(kind)?.rootFor?.(location, id);
}

export function isWritable(kind: ResourceKind): boolean {
  return layoutOf(kind)?.isWritable ?? false;
}

/** Список файлов ресурса. Для одиночного файла — он сам. */
export function listResourceFiles(
  kind: ResourceKind,
  id: string,
  location: ClaudeLocation,
): ResourceFile[] {
  const layout = layoutOf(kind);
  const root = rootOf(kind, id, location);
  if (!layout || !root || !existsSync(root)) return [];

  if (!layout.isDirectory) {
    // У одиночного файла (скрипт, хук) идентификатор — это имя файла. Берём
    // из него только имя без пути: иначе через id="../x" можно было бы
    // выйти из папки.
    const name = basename(id);
    if (!name || name === '.' || name === '..') return [];

    const target = join(root, name);
    return existsSync(target) && statSync(target).isFile() ? [describe(root, name)] : [];
  }

  return walk(root, root, '', new Set(layout.ignoreDirs)).sort((a, b) =>
    a.path.localeCompare(b.path),
  );
}

export function readResourceFile(
  kind: ResourceKind,
  id: string,
  file: string,
  location: ClaudeLocation,
): { content: string; isBinary: boolean } {
  const target = safePath(kind, id, file, location);
  if (!target || !existsSync(target)) return { content: '', isBinary: false };

  if (isBinaryPath(target)) return { content: '', isBinary: true };
  if (statSync(target).size > MAX_READABLE) {
    return { content: 'Файл слишком большой для просмотра', isBinary: false };
  }

  return { content: readFileSync(target, 'utf8'), isBinary: false };
}

export function writeResourceFile(
  kind: ResourceKind,
  id: string,
  file: string,
  content: string,
  location: ClaudeLocation,
  backupDir?: string,
  /** Не трогать файл, если он уже есть, — нужно шаблонам. */
  skipExisting = false,
): void {
  assertWritable(kind);

  const target = safePath(kind, id, file, location);
  if (!target) throw new Error('Путь выходит за пределы ресурса');
  if (skipExisting && existsSync(target)) return;

  mkdirSync(dirname(target), { recursive: true });
  writeTextFile(target, content, { backupDir });
}

/**
 * Удаление файла или папки внутри ресурса — под резервную копию: отменить его
 * в интерфейсе нечем, а стереть можно целую вложенную папку.
 *
 * Удаляем через `removeEntry`, а не `rmSync`: рекурсивный `rmSync` на путях с
 * нелатинскими символами рапортует об успехе, ничего не удалив (см. safe-io.ts),
 * а имена файлов внутри скилла пишет пользователь.
 */
export function deleteResourceFile(
  kind: ResourceKind,
  id: string,
  file: string,
  location: ClaudeLocation,
  backupDir?: string,
): string | undefined {
  assertWritable(kind);

  const target = safePath(kind, id, file, location);
  if (!target || !existsSync(target)) return undefined;

  const backupPath = backupDir
    ? backupEntry(target, backupDir, `${kind}-${id}-${basename(target)}`)
    : undefined;

  removeEntry(target);
  return backupPath;
}

export function moveResourceFile(
  kind: ResourceKind,
  id: string,
  from: string,
  to: string,
  location: ClaudeLocation,
): void {
  assertWritable(kind);

  const source = safePath(kind, id, from, location);
  const target = safePath(kind, id, to, location);
  if (!source || !target || !existsSync(source)) throw new Error('Неверный путь');

  // Перенос не должен молча затирать существующий файл — иначе одна опечатка
  // в имени уничтожает чужое содержимое без следа.
  if (existsSync(target)) throw new Error('Файл с таким именем уже существует');

  mkdirSync(dirname(target), { recursive: true });
  renameSync(source, target);
}

function assertWritable(kind: ResourceKind): void {
  if (!isWritable(kind)) throw new Error('Этот вид ресурса доступен только для чтения');
}

/**
 * Путь к файлу внутри ресурса. Имя приходит из запроса, поэтому проверяется,
 * что результат остаётся внутри корня и указывает на файл, а не на сам корень.
 *
 * Совпадение с корнем отвергается намеренно: пустой `file` или `.` привёл бы
 * к операции над всей папкой ресурса — а удаление такого пути снесло бы весь
 * скилл целиком. Файл всегда должен быть строго внутри.
 */
function safePath(
  kind: ResourceKind,
  id: string,
  file: string,
  location: ClaudeLocation,
): string | undefined {
  const root = rootOf(kind, id, location);
  if (!root) return undefined;

  // Пустое имя или одни точки не адресуют файл — это ссылка на саму папку.
  const trimmed = file.trim();
  if (!trimmed || /^\.+$/.test(trimmed.replace(/[/\\]/g, ''))) return undefined;

  const base = resolve(root);
  const target = resolve(base, trimmed);

  // Строго внутри корня: сам корень и всё, что снаружи, — отказ. Сравниваем
  // с разделителем на конце, иначе соседняя папка с похожим именем прошла бы.
  return target.startsWith(`${base}${sep}`) ? target : undefined;
}

/** Обход папки. Путь наружу отдаётся относительным, а stat берётся по полному. */
function walk(root: string, dir: string, prefix = '', ignore?: Set<string>): ResourceFile[] {
  const result: ResourceFile[] = [];

  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory() && ignore?.has(entry.name)) continue;

    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;

    if (entry.isDirectory()) result.push(...walk(root, join(dir, entry.name), relative, ignore));
    else result.push(describe(root, relative));
  }

  return result;
}

function describe(root: string, relative: string): ResourceFile {
  const stats = statSync(join(root, ...relative.split('/')));

  return {
    path: relative,
    sizeBytes: stats.size,
    modifiedAt: stats.mtime.toISOString(),
    isBinary: isBinaryPath(relative),
  };
}

function isBinaryPath(path: string): boolean {
  const dot = path.lastIndexOf('.');
  return dot >= 0 && BINARY_EXTENSIONS.has(path.slice(dot).toLowerCase());
}
