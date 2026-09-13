import type { Deck } from '@agentdeck/contracts';
import { readImageBytes, readImageRecord } from '../store.ts';

/**
 * Картинки колоды — байтами, а не ссылками.
 *
 * Страница колоды и файл PowerPoint обязаны быть самодостаточными: HTML
 * открывается с `default-src 'none'`, PPTX уезжает на чужую машину. Поэтому
 * растровая картинка, которую панель нарисовала для слайда, попадает внутрь
 * файла — сюда её приносит `pictureId` слайда, а превращает в `data:`-адрес этот
 * модуль.
 *
 * Почему не хранить сам `data:`-адрес в колоде: колода лежит на диске рядом с
 * файлами и целиком уезжает модели при правке — полумегабайтный base64 в ней
 * означал бы, что «поправь третий слайд» отправляет наверх все картинки.
 */

/** Доступ отрисовщика к картинкам этой колоды. Ничего, кроме них, он не увидит. */
export interface DeckAssets {
  /** `data:`-адрес картинки слайда. Пусто — файла нет, слайд рисуется без него. */
  picture(id: string): string | undefined;
}

/** Пустой набор: колода без картинок и все прежние колоды с диска. */
export const NO_ASSETS: DeckAssets = { picture: () => undefined };

/**
 * Собрать набор для колоды. Читает только те файлы, которые названы в её же
 * слайдах, и читает КАЖДЫЙ ОДИН РАЗ: одна картинка может стоять на нескольких
 * слайдах, а base64 от неё — это мегабайты.
 */
export function deckAssets(appDataDir: string, deck: Deck): DeckAssets {
  const wanted = new Set(
    deck.slides.flatMap((slide) => (slide.pictureId ? [slide.pictureId] : [])),
  );
  if (wanted.size === 0) return NO_ASSETS;

  const found = new Map<string, string>();
  for (const id of wanted) {
    const uri = dataUri(appDataDir, id);
    if (uri) found.set(id, uri);
  }
  return { picture: (id) => found.get(id) };
}

/**
 * Одна картинка `data:`-адресом. Пропавший файл — это не отказ: колода старше
 * потолка хранилища (`trimImages`) по-прежнему открывается, просто без снимка.
 */
function dataUri(appDataDir: string, id: string): string | undefined {
  try {
    const record = readImageRecord(appDataDir, id);
    if (!record) return undefined;
    const bytes = readImageBytes(appDataDir, record);
    return `data:${record.mime};base64,${bytes.toString('base64')}`;
  } catch {
    return undefined;
  }
}
