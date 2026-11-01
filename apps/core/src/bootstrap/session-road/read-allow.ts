import { readCoreConfig, sectionProblem } from '../../platform/core-config/read.ts';
import { pathKey } from '../../platform/paths.ts';

/**
 * Список чтения человека вне копии (F-87, решение владельца): только из конфига ядра, по
 * исходному репозиторию — `config.json` → `readAllow: {"<путь репозитория>": ["<путь>", …]}`.
 * Никогда из файлов репозитория и не инструментом модели. Читается на каждую подготовку сессии
 * единым читателем настройки: правка человека через API действует со следующей сессии, правка
 * мимо API (дрейф, G6) — не действует. Файла нет — списка нет; не читается или раздел не прошёл
 * схему — тоже пусто (область сужается, не расширяется), причина названа.
 */

export interface ReadAllowOutcome {
  entries: string[];
  /** Почему список не прочитан (файл есть, но не JSON / не та форма / не читается). */
  problem?: string;
}

export function readAllowFor(configPath: string, repo: string | undefined): ReadAllowOutcome {
  if (repo === undefined) return { entries: [] };
  const read = readCoreConfig({ config: configPath });
  if ('absent' in read) return { entries: [] };
  if ('unknown' in read) return { entries: [], problem: `core config unreadable: ${read.unknown}` };
  const problem = sectionProblem(read.value, 'readAllow');
  if (problem) return { entries: [], problem };
  const want = pathKey(repo);
  for (const [key, list] of Object.entries(read.value.doc.readAllow ?? {})) {
    if (pathKey(key) === want) return { entries: list };
  }
  return { entries: [] };
}
