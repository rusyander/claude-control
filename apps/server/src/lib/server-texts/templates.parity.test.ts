import { describe, expect, it } from 'vitest';
import { serverMessagesEn } from '../../../../web/src/shared/config/i18n/server-messages/en.ts';
import { serverMessagesRu } from '../../../../web/src/shared/config/i18n/server-messages/ru.ts';
import { serverTextTemplates } from './templates.ts';

/**
 * Один и тот же текст живёт в трёх копиях: шаблон сервера (им сервер собирает
 * строку и по нему же разбирает её обратно в код), словарь панели (его видит
 * человек) и словарь телефона. Телефон сверяется с панелью файл в файл
 * (`tools/qa/check-mobile-contracts.mjs`); здесь — сервер с панелью, по каждому
 * общему коду и на обоих языках. Ревью 28.09 (F-209): правка кавычек в одной
 * копии тихо расходилась с двумя другими.
 */
describe('шаблоны сервера совпадают со словарём панели', () => {
  const templates = serverTextTemplates as Record<string, { ru: string; en: string }>;
  const dictionaries = {
    ru: serverMessagesRu as Record<string, string>,
    en: serverMessagesEn as Record<string, string>,
  };

  for (const language of ['ru', 'en'] as const) {
    it(`${language}: каждый код сервера есть в словаре панели тем же текстом`, () => {
      const dictionary = dictionaries[language];
      const drift = Object.entries(templates).flatMap(([code, text]) =>
        dictionary[code] === text[language]
          ? []
          : [`${code}\n  server: ${text[language]}\n  web:    ${dictionary[code] ?? '(нет)'}`],
      );
      expect(drift).toEqual([]);
    });
  }
});
