import { readBytesSync } from '../../platform/safe-io/files.ts';
import { pathKey } from '../../platform/paths.ts';

/**
 * Список чтения человека вне копии (F-87, решение владельца): только из конфига ядра, по
 * исходному репозиторию — `config.json` → `readAllow: {"<путь репозитория>": ["<путь>", …]}`.
 * Никогда из файлов репозитория и не инструментом модели. Читается на каждую подготовку сессии:
 * правка человека действует со следующей сессии. Файла нет — списка нет; не читается или не той
 * формы — тоже пусто (область сужается, не расширяется), причина названа.
 */

export interface ReadAllowOutcome {
  entries: string[];
  /** Почему список не прочитан (файл есть, но не JSON / не та форма / не читается). */
  problem?: string;
}

export function parseReadAllow(text: string, repo: string): ReadAllowOutcome {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch (error) {
    return { entries: [], problem: `core config: not JSON (${(error as Error).message})` };
  }
  if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) {
    return { entries: [], problem: 'core config: not an object' };
  }
  const section = (doc as Record<string, unknown>).readAllow;
  if (section === undefined) return { entries: [] };
  if (typeof section !== 'object' || section === null || Array.isArray(section)) {
    return { entries: [], problem: 'readAllow: not an object keyed by repository path' };
  }
  const want = pathKey(repo);
  for (const [key, list] of Object.entries(section as Record<string, unknown>)) {
    if (pathKey(key) !== want) continue;
    if (!Array.isArray(list) || list.some((entry) => typeof entry !== 'string')) {
      return { entries: [], problem: `readAllow[${key}]: not a list of strings` };
    }
    return { entries: list as string[] };
  }
  return { entries: [] };
}

export function readAllowFor(configPath: string, repo: string | undefined): ReadAllowOutcome {
  if (repo === undefined) return { entries: [] };
  const bytes = readBytesSync(configPath);
  if ('absent' in bytes) return { entries: [] };
  if (!('value' in bytes))
    return { entries: [], problem: `core config unreadable: ${bytes.unknown}` };
  return parseReadAllow(bytes.value.toString('utf8'), repo);
}
