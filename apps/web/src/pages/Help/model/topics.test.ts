import { describe, expect, it } from 'vitest';
import { NAV_SECTIONS } from '@shared/config/navigation';
import { helpRu } from '@shared/config/i18n/help/ru';
import { HELP_GROUPS, findHelpTopic, findTopicNeighbours } from './topics';

/**
 * Индекс справки — единственное место, где документ становится видимым: адрес
 * `?topic=`, переход к соседнему разделу и сам список берутся отсюда. Ошибка тут
 * не падает и не краснеет — документ просто не находится, а человек читает
 * пустую страницу вместо ответа.
 *
 * Кадры и свежесть текстов проверяют свои стражи (`check-help.mjs`,
 * `check-help-shots.mjs`); здесь — только то, что видно из кода: уникальность
 * идентификаторов, живой раздел за каждым документом, словарные ключи и порядок
 * чтения подряд.
 */
const TOPICS = HELP_GROUPS.flatMap((group) => group.topics);
const NAV_PATHS = new Set(NAV_SECTIONS.flatMap((section) => section.items.map((it) => it.path)));

describe('индекс справки', () => {
  it('идентификаторы уникальны: второй такой же перекрыл бы первый в адресе', () => {
    const ids = TOPICS.map((topic) => topic.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('за каждым документом стоит живой раздел панели', () => {
    for (const topic of TOPICS) {
      expect(NAV_PATHS.has(topic.pagePath), `${topic.id} → ${topic.pagePath}`).toBe(true);
    }
  });

  it('у каждого документа есть название и подпись в словаре', () => {
    for (const topic of TOPICS) {
      const texts = helpRu.topics[topic.id as keyof typeof helpRu.topics] as
        { title?: string; summary?: string } | undefined;
      expect(texts?.title, `${topic.id}.title`).toBeTruthy();
      expect(texts?.summary, `${topic.id}.summary`).toBeTruthy();
    }
  });

  it('подписи групп совпадают с секциями бокового меню', () => {
    const sections = new Set(NAV_SECTIONS.map((section) => section.label));
    for (const group of HELP_GROUPS)
      expect(sections.has(group.labelKey), group.labelKey).toBe(true);
  });

  it('поиск по адресу находит документ и молчит о неизвестном', () => {
    expect(findHelpTopic('chat')?.pagePath).toBe('/chat');
    expect(findHelpTopic('нет-такого')).toBeUndefined();
    expect(findHelpTopic(undefined)).toBeUndefined();
  });

  it('соседи сквозные: границы групп не мешают читать подряд', () => {
    const first = TOPICS[0]!;
    const last = TOPICS[TOPICS.length - 1]!;
    expect(findTopicNeighbours(first.id).prev).toBeUndefined();
    expect(findTopicNeighbours(first.id).next?.id).toBe(TOPICS[1]?.id);
    expect(findTopicNeighbours(last.id).next).toBeUndefined();
    // Последний документ группы ведёт в СЛЕДУЮЩУЮ группу, а не в никуда.
    const groupEnd = HELP_GROUPS[0]!.topics.at(-1)!;
    expect(findTopicNeighbours(groupEnd.id).next?.id).toBe(HELP_GROUPS[1]!.topics[0]!.id);
    expect(findTopicNeighbours('нет-такого')).toEqual({});
  });
});
