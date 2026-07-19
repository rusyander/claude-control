import { readdirSync, statSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { join, extname } from 'node:path';
import { readTextFile, writeTextFile } from '../lib/safe-io.ts';

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

export function readScripts(hooksDir: string, usedPaths: string[]): ScriptFile[] {
  if (!existsSync(hooksDir)) return [];

  // Пути в конфиге пишутся с разными разделителями — сравниваем по имени файла.
  const usedNames = new Set(usedPaths.map((path) => path.replace(/\\/g, '/').split('/').pop()));

  return readdirSync(hooksDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && SCRIPT_EXTENSIONS.has(extname(entry.name).toLowerCase()))
    .map((entry) => {
      const path = join(hooksDir, entry.name);
      const stats = statSync(path);

      return {
        id: entry.name,
        name: entry.name,
        extension: extname(entry.name),
        path,
        sizeBytes: stats.size,
        modifiedAt: stats.mtime.toISOString(),
        description: readDescription(path),
        isUsed: usedNames.has(entry.name),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function readScriptContent(hooksDir: string, id: string): string {
  return readTextFile(join(hooksDir, sanitizeName(id)));
}

export function saveScript(
  hooksDir: string,
  id: string,
  content: string,
  backupDir?: string,
): string | undefined {
  mkdirSync(hooksDir, { recursive: true });
  return writeTextFile(join(hooksDir, sanitizeName(id)), content, { backupDir });
}

export function deleteScript(hooksDir: string, id: string): void {
  const path = join(hooksDir, sanitizeName(id));
  if (existsSync(path)) rmSync(path, { force: true });
}

/**
 * Имя файла приходит из запроса, поэтому вырезаем всё, кроме безопасных
 * символов: иначе через «..» можно было бы дотянуться до чужих каталогов.
 */
function sanitizeName(name: string): string {
  const cleaned = name.replace(/[^a-zA-Z0-9._-]/g, '');
  return cleaned || 'script.mjs';
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
