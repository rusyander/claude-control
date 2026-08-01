import { existsSync, readdirSync } from 'node:fs';
import { basename, join, relative } from 'node:path';
import type { ConfigProvider } from '../../../providers/types.ts';
import { providerLocations } from '../locations.ts';
import { byPriority, EXCLUDED_DIRS, VENV_MARKER } from './rules.ts';
import { takeFile } from './take-file.ts';
import type { CollectResult } from './types.ts';

/** Обход мест провайдера: кто кандидат, в каком порядке и что из этого взято. */

/** Собирает всё, что поедет в архив, вместе со списком пропущенного. */
export function collectProviderFiles(provider: ConfigProvider, override?: string): CollectResult {
  const locations = providerLocations(provider, override);
  const result: CollectResult = {
    locations,
    files: [],
    skipped: [],
    checklist: [],
    totalBytes: 0,
  };

  for (const location of locations) {
    if (!existsSync(location.path)) continue;
    if (location.kind === 'file') {
      takeFile(provider, location, basename(location.path), location.path, result);
      continue;
    }

    // Сначала список всех кандидатов, потом отбор ПО ВАЖНОСТИ: настройка —
    // вперёд, всё прочее — следом. Иначе первый же тяжёлый вспомогательный
    // каталог съел бы предел архива, и скиллы с хуками в него не попали бы
    // (в живом `~/.claude` так и вышло на первой же проверке).
    const candidates = collectCandidates(location.path, result);
    candidates.sort(byPriority);
    for (const relativePath of candidates) {
      takeFile(
        provider,
        location,
        relativePath,
        join(location.path, ...relativePath.split('/')),
        result,
      );
    }
  }

  return result;
}

/** Пути всех файлов места (относительные), с отсевом исключённых каталогов. */
function collectCandidates(root: string, result: CollectResult): string[] {
  const found: string[] = [];

  const walk = (dir: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      result.skipped.push({ sourcePath: dir, reason: 'unreadable' });
      return;
    }

    // Виртуальное окружение узнаётся по файлу-признаку, а не по имени папки.
    if (entries.some((entry) => entry.isFile() && entry.name === VENV_MARKER)) {
      result.skipped.push({ sourcePath: dir, reason: 'excluded' });
      return;
    }

    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const full = join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        // Симлинк на новой машине указывал бы в пустоту, а вести по нему обход —
        // приглашение выйти за пределы каталога. Пропускаем и говорим об этом.
        result.skipped.push({ sourcePath: full, reason: 'excluded' });
        continue;
      }
      if (entry.isDirectory()) {
        if (EXCLUDED_DIRS.has(entry.name.toLowerCase())) {
          result.skipped.push({ sourcePath: full, reason: 'excluded' });
          continue;
        }
        walk(full);
        continue;
      }
      if (entry.isFile()) found.push(toArchiveRelative(root, full));
    }
  };

  walk(root);
  return found;
}

/** Путь внутри места, всегда через прямой слэш (архив един для всех ОС). */
function toArchiveRelative(root: string, path: string): string {
  return relative(root, path).split(/[\\/]/).join('/');
}
