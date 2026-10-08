import { randomUUID } from 'node:crypto';
import { readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { writeAgentImages, type AgentImage } from '../../lib/agent-images/agent-images.ts';

/**
 * Картинки для агента, который читает файлы САМ (чат чужого CLI): у него нет
 * входа для картинки в запросе, зато есть инструменты чтения — ровно как у
 * вложений чата Claude. Картинка ложится файлом в каталог данных панели, путь
 * уходит во вложения сообщения.
 *
 * Каталог на каждую отправку свой (имя в пути порядковое, имя из запроса туда не
 * попадает). Путь остаётся в реплике разговора, а разговор чужого CLI уходит
 * агенту ЦЕЛИКОМ на каждом ходе — поэтому хранится не «последние N», а по сроку
 * (F-267: при 50 последних разговор, продолженный после 50 других отправок,
 * терял свои картинки). Старше `MAX_AGE_MS` — прочь; больше `HARD_CAP` — прочь
 * старейшие, но не моложе `MIN_AGE_MS` (агент читает файл в том же ходе). И
 * никогда — каталог, который упоминает сохранённый разговор (`referenced`).
 */
const DIR = 'agent-images';
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const MIN_AGE_MS = 24 * 60 * 60 * 1000;
const HARD_CAP = 500;

export interface AgentImageFile {
  /** Имя, как его видел человек. */
  name: string;
  /** Абсолютный путь — его и получает агент. */
  path: string;
}

export interface AgentFileRetention {
  /**
   * Какие из имён каталогов упоминает сохранённый разговор. Спрашивается только
   * о кандидатах на удаление. Не задано — не упоминает никто.
   */
  referenced?: (names: readonly string[]) => ReadonlySet<string>;
  now?: number;
}

export function storeAgentImageFiles(
  appDataDir: string,
  images: readonly AgentImage[],
  makeId: () => string = randomUUID,
  retention: AgentFileRetention = {},
): AgentImageFile[] {
  const root = join(appDataDir, DIR);
  const paths = writeAgentImages(join(root, makeId()), images);
  prune(root, retention);
  return images.map((image, index) => ({ name: image.name, path: paths[index]! }));
}

/** Кандидаты — по сроку и сверх потолка; упомянутые разговором остаются. */
function prune(root: string, retention: AgentFileRetention): void {
  let entries: { name: string; path: string; at: number }[];
  try {
    entries = readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => {
        const path = join(root, entry.name);
        return { name: entry.name, path, at: statSync(path).mtimeMs };
      });
  } catch {
    return;
  }
  const now = retention.now ?? Date.now();
  entries.sort((a, b) => b.at - a.at);
  const candidates = entries.filter(
    (entry, index) =>
      now - entry.at > MAX_AGE_MS || (index >= HARD_CAP && now - entry.at > MIN_AGE_MS),
  );
  if (candidates.length === 0) return;
  let keep: ReadonlySet<string>;
  try {
    keep = retention.referenced?.(candidates.map((entry) => entry.name).sort()) ?? new Set();
  } catch {
    // Разговоры не прочлись — что упомянуто, неизвестно: не удаляем ничего.
    return;
  }
  for (const old of candidates) {
    if (keep.has(old.name)) continue;
    try {
      rmSync(old.path, { recursive: true, force: true });
    } catch {
      // Файл держит чужой процесс (агент ещё читает) — уберётся следующим проходом.
    }
  }
}
