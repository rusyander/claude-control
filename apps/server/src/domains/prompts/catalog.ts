import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PROMPT_IDS, type PromptId } from '@agentdeck/contracts/prompts';

/**
 * Встроенные тексты промптов: репозиторий — их единственный источник.
 *
 * Тексты лежат в `catalog/*.md` рядом, а не строками в коде, по трём причинам:
 * их правят целыми абзацами (в diff видно, ЧТО сказали модели, а не где сдвинулась
 * кавычка), их читает человек в панели один в один с файлом, и они уезжают модели
 * байт в байт — поэтому каталог исключён из prettier (`.prettierignore`): пример
 * JSON внутри промпта переформатировать нельзя.
 *
 * ВЕРСИЯ — метка для человека: «встроенный текст с тех пор переписали». Ответ на
 * вопрос «а мой-то текст устарел?» даёт не она, а отпечаток встроенного текста
 * (`builtinSha`), записанный в правку при сохранении: версию забывают поднять,
 * отпечаток забыть нельзя.
 */

export interface PromptCatalogEntry {
  id: PromptId;
  /** Растёт при правке встроенного текста. Человеку — метка, коду — ничего. */
  version: number;
  /**
   * Кто читает этот текст. Не для кода: это ответ человеку, открывшему карточку,
   * на вопрос «если я это перепишу — что изменится».
   */
  usedBy: string;
}

export const PROMPT_CATALOG: readonly PromptCatalogEntry[] = [
  {
    id: 'tool-protocol',
    version: 1,
    usedBy:
      'прослойка инструментов шлюза: текстовый протокол вызова для моделей без своих инструментов',
  },
  {
    id: 'contour-agent',
    version: 1,
    usedBy: 'прогон агента через контур: заменяет системный промпт CLI',
  },
  {
    id: 'contour-preamble',
    version: 1,
    usedBy: 'любой разговор через контур: честные ограничения контура в начале',
  },
  { id: 'image', version: 1, usedBy: 'режим картинки: просьба человека → задание генератору' },
  { id: 'presentation', version: 1, usedBy: 'режим презентации: тема → слайды' },
];

/** Запись каталога по идентификатору. Неизвестного здесь быть не может — тип закрыт. */
export function promptEntry(id: PromptId): PromptCatalogEntry {
  const entry = PROMPT_CATALOG.find((item) => item.id === id);
  if (!entry) throw new Error(`промпт «${id}» не описан в каталоге`);
  return entry;
}

/**
 * Кэш на процесс: файлы каталога приезжают с панелью и при работе не меняются,
 * а читаются они на каждый запрос режима.
 */
const cache = new Map<PromptId, string>();

/** Встроенный текст. Единственное место в панели, которое читает `catalog/*.md`. */
export function builtinPromptText(id: PromptId): string {
  const cached = cache.get(id);
  if (cached !== undefined) return cached;

  const path = fileURLToPath(new URL(`./catalog/${id}.md`, import.meta.url));
  const text = readFileSync(path, 'utf8');
  cache.set(id, text);
  return text;
}

/** Отпечаток встроенного текста: им правка узнаёт, что панель обновилась. */
export function builtinPromptSha(id: PromptId): string {
  return createHash('sha256').update(builtinPromptText(id), 'utf8').digest('hex');
}

/** Все идентификаторы каталога в порядке показа. */
export function promptIds(): readonly PromptId[] {
  return PROMPT_IDS;
}
