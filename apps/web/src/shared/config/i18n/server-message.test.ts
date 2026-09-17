import { describe, expect, it } from 'vitest';
import {
  serverMessageCodes,
  serverMessageParams,
  templateParams,
} from '@agentdeck/contracts/server-messages';
import { serverMessagesEn } from './server-messages/en';
import { serverMessagesRu } from './server-messages/ru';
import { i18n } from './instance';
import { serverMessageFromPayload, serverMessageText } from './server-message';

/**
 * Каждый код сервера переведён на оба языка, и перевод использует ровно те
 * подстановки, что объявлены у кода. `Record` ловит пропуск на сборке, но не
 * пустую строку и не забытое `{{title}}` — это ловит тест.
 */
describe('тексты сервера по коду', () => {
  const dictionaries = { ru: serverMessagesRu, en: serverMessagesEn };

  for (const [language, dictionary] of Object.entries(dictionaries)) {
    it(`${language}: у каждого кода непустой текст с объявленными подстановками`, () => {
      const problems = serverMessageCodes.flatMap((code) => {
        const text = (dictionary as Record<string, string | undefined>)[code];
        if (!text?.trim()) return [`${code}: нет перевода`];
        const used = [...new Set(templateParams(text))].sort();
        const declared = [...serverMessageParams[code]].sort();
        return JSON.stringify(used) === JSON.stringify(declared)
          ? []
          : [`${code}: подстановки ${used.join(',')} ≠ ${declared.join(',')}`];
      });
      expect(problems).toEqual([]);
      // Лишний ключ — код, которого сервер больше не шлёт: словарь врёт о контракте.
      expect(Object.keys(dictionary).sort()).toEqual([...serverMessageCodes].sort());
    });
  }

  it('код переводится на язык интерфейса, незнакомый код — пусто (показывается текст сервера)', async () => {
    await i18n.changeLanguage('en');
    expect(
      serverMessageFromPayload({
        message: 'Контур «dev» не подключён: включите его и сохраните ключ.',
        messageCode: 'platform-not-connected',
        params: { title: 'dev' },
      }),
    ).toBe('Contour “dev” is not connected: enable it and save the key.');
    expect(serverMessageText('capability-chat-none')).toBe('no chat models granted to the key');
    expect(serverMessageFromPayload({ messageCode: 'from-a-newer-server' })).toBeUndefined();
    await i18n.changeLanguage('ru');
    expect(serverMessageText('run-empty-prompt')).toBe('Сообщение пустое — отправлять нечего.');
  });
});
