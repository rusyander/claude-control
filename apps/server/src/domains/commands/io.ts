import { readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join } from 'node:path';

/**
 * Чтение с диска для раздела команд: обход каталогов и терпимое чтение файлов.
 * Ни одна ошибка чтения не роняет список — команда всё равно существует.
 */

/** Сколько файлов читаем максимум: защита от каталога, набитого мусором. */
export const FILE_LIMIT = 500;

export interface FoundFile {
  path: string;
  /** Путь относительно корня каталога, через `/` — из него строится имя. */
  relative: string;
}

export function listFiles(dir: string, extension: string, recursive: boolean): FoundFile[] {
  if (!isDirectory(dir)) return [];

  const found: FoundFile[] = [];
  const walk = (current: string, prefix: string): void => {
    if (found.length >= FILE_LIMIT) return;
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (found.length >= FILE_LIMIT) return;
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        if (recursive) walk(path, `${prefix}${entry.name}/`);
        continue;
      }
      if (extname(entry.name).toLowerCase() === extension) {
        found.push({ path, relative: `${prefix}${entry.name}` });
      }
    }
  };

  walk(dir, '');
  return found;
}

export function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

export function readText(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
}

export function readJson(path: string): unknown {
  const text = readText(path);
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
