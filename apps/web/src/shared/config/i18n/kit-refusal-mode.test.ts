import { describe, expect, it } from 'vitest';
import { kitEn } from './kit/en';
import { kitRu } from './kit/ru';
import { serverMessagesEn } from './server-messages/en';
import { serverMessagesRu } from './server-messages/ru';

/**
 * Отказ «набор не собрался» и отказ «набор Codex длиннее предела» советуют
 * режим набора — и называют его тем словом, которое человек видит на странице
 * «Набор панели». Совет переключиться на «Глобальные» вёл к кнопке, которой
 * нет: режим называется «Только ваши». Копии этих текстов у сервера и телефона
 * сверяются с панельными своими сторожами (parity и `pnpm mobile:contracts`).
 */
const pageLabel = (label: string): string => label.replace(/\s*\(.*\)\s*$/, '');

describe('отказы набора называют режим словами страницы', () => {
  const cases = [
    { language: 'ru', messages: serverMessagesRu, label: pageLabel(kitRu.modes.mode.global) },
    { language: 'en', messages: serverMessagesEn, label: pageLabel(kitEn.modes.mode.global) },
  ] as const;

  for (const { language, messages, label } of cases) {
    it(`${language}: kit-compose-failed советует «${label}»`, () => {
      expect(messages['kit-compose-failed']).toContain(`«${label}»`);
    });
    it(`${language}: kit-codex-too-large советует «${label}» и называет предел и размер`, () => {
      const text = (messages as Record<string, string | undefined>)['kit-codex-too-large'] ?? '';
      expect(text).toContain(`«${label}»`);
      expect(text).toContain('{{limit}}');
      expect(text).toContain('{{size}}');
    });
  }
});
