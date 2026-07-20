import { readdirSync, statSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { join, extname, relative, sep } from 'node:path';
import { readTextFile, writeTextFile, backupEntry } from '../lib/safe-io.ts';

/**
 * Скрипты в каталоге hooks/. Это обычные файлы, которые запускают хуки, но
 * управлять ими удобнее отдельно от привязок к событиям: один скрипт может
 * вызываться из нескольких хуков, а редактировать его приходится как код.
 */

export interface ScriptFile {
  /** Имя файла с расширением — оно же идентификатор. */
  id: string;
  name: string;
  extension: string;
  path: string;
  sizeBytes: number;
  modifiedAt: string;
  /** Первые строки комментария — краткое описание для списка. */
  description?: string;
  /** Используется ли скрипт хотя бы одним хуком. */
  isUsed: boolean;
}

const SCRIPT_EXTENSIONS = new Set(['.mjs', '.cjs', '.js', '.ts', '.sh', '.ps1', '.py']);

/**
 * Обход hooks/ вглубь: скрипт может лежать в подпапке, а хук ссылаться на него
 * по вложенному пути. Возвращаем относительные пути с прямыми слэшами — они же
 * идентификаторы. Скрытые каталоги и node_modules пропускаем.
 */
function walkScripts(dir: string, base: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      found.push(...walkScripts(full, base));
    } else if (entry.isFile() && SCRIPT_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
      found.push(relative(base, full).split(sep).join('/'));
    }
  }
  return found;
}

export function readScripts(hooksDir: string, usedPaths: string[]): ScriptFile[] {
  if (!existsSync(hooksDir)) return [];

  // Пути в конфиге пишутся с разными разделителями — нормализуем к прямым слэшам.
  const usedNorm = usedPaths.map((path) => path.replace(/\\/g, '/'));
  const usedNames = new Set(usedNorm.map((path) => path.split('/').pop()));

  return walkScripts(hooksDir, hooksDir)
    .map((rel) => {
      const path = join(hooksDir, rel);
      const stats = statSync(path);
      const fileName = rel.split('/').pop() ?? rel;

      return {
        id: rel,
        // Для вложенного скрипта показываем путь целиком — иначе не отличить
        // одноимённые файлы из разных папок.
        name: rel,
        extension: extname(fileName),
        path,
        sizeBytes: stats.size,
        modifiedAt: stats.mtime.toISOString(),
        description: readDescription(path),
        // Совпадение по относительному пути на границе сегмента (или полное),
        // иначе — запасной по имени файла. Без границы `precheck.mjs` ложно
        // «использовал» бы `check.mjs`.
        isUsed:
          usedNorm.some((used) => used === rel || used.endsWith(`/${rel}`)) ||
          usedNames.has(fileName),
      };
    })
    .sort((a, b) => a.id.localeCompare(b.id));
}

export function readScriptContent(hooksDir: string, id: string): string {
  return readTextFile(join(hooksDir, sanitizeRelPath(id)));
}

export function saveScript(
  hooksDir: string,
  id: string,
  content: string,
  backupDir?: string,
): string | undefined {
  const target = join(hooksDir, sanitizeRelPath(id));
  mkdirSync(dirOf(target), { recursive: true });
  return writeTextFile(target, content, { backupDir });
}

/**
 * Удаление скрипта. Как и удаление скилла (см. deleteSkill), снимаем копию до
 * стирания: файл скрипта хука иначе теряется безвозвратно — копия единственный
 * способ отмены. Возвращаем путь резервной копии, чтобы маршрут его отдал.
 */
export function deleteScript(hooksDir: string, id: string, backupDir?: string): string | undefined {
  const path = join(hooksDir, sanitizeRelPath(id));
  if (!existsSync(path)) return undefined;

  const backupPath = backupDir ? backupEntry(path, backupDir) : undefined;
  rmSync(path, { force: true });
  return backupPath;
}

/** Каталог файла — чтобы создать вложенные папки перед записью. */
function dirOf(path: string): string {
  const at = Math.max(path.lastIndexOf('/'), path.lastIndexOf(sep));
  return at > 0 ? path.slice(0, at) : path;
}

/**
 * Идентификатор приходит из запроса и может быть вложенным путём. Разрешаем
 * подпапки, но каждый сегмент чистим до безопасных символов и выкидываем `.`,
 * `..` и пустые — так `join(hooksDir, …)` не выйдет за пределы каталога.
 */
function sanitizeRelPath(id: string): string {
  const parts = id
    .replace(/\\/g, '/')
    .split('/')
    .map((segment) => segment.replace(/[^a-zA-Z0-9._-]/g, ''))
    .filter((segment) => segment && segment !== '.' && segment !== '..');
  return parts.join('/') || 'script.mjs';
}

/** Первые строки комментария в шапке файла. */
function readDescription(path: string): string | undefined {
  const lines = readTextFile(path).split(/\r?\n/).slice(0, 8);
  const comments: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    // Shebang начинается с решётки, но описанием не является.
    if (trimmed.startsWith('#!')) continue;
    if (trimmed.startsWith('//') || trimmed.startsWith('#') || trimmed.startsWith('*')) {
      comments.push(trimmed.replace(/^(\/\/|#|\*|\/\*\*?)\s?/, ''));
      continue;
    }
    if (comments.length > 0) break;
  }

  return comments.join(' ').trim() || undefined;
}
