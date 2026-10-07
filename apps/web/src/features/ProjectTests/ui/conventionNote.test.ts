import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { i18n, loadHelp } from '@shared/config/i18n';

/**
 * Ф14: полоса прогона писала «Из чата кейсы не ведутся», а справка (и сервер:
 * `testsChatNote` дописывает строку о разделе КАЖДОМУ агенту чата проекта)
 * говорит обратное. Без блока в CLAUDE.md о кейсах не знает только CLI мимо
 * панели — это полоса и должна сказать, на обоих языках.
 */
describe('подпись о соглашении CLAUDE.md', () => {
  beforeAll(async () => {
    // Сначала основной словарь английского (он приезжает сменой языка), потом
    // справка: иначе её пакет занял бы `en`, и основной уже не подгрузился бы.
    await i18n.changeLanguage('en');
    await i18n.changeLanguage('ru');
    await Promise.all([loadHelp('ru'), loadHelp('en')]);
  });
  afterAll(async () => {
    await i18n.changeLanguage('ru');
  });

  for (const lng of ['ru', 'en'] as const) {
    it(`${lng}: не отрицает, что чат панели ведёт кейсы`, async () => {
      // Английский словарь приезжает сменой языка, как в живой панели.
      await i18n.changeLanguage(lng);
      const t = (key: string): string => i18n.t(key);
      const help = t('help.topics.tests.agentConventionText');
      const off = `${t('projectTests.conventionOff')} ${t('projectTests.conventionOffText')}`;
      const on = t('projectTests.conventionOn');
      // Справка — источник: чат проекта о разделе знает.
      expect(help).toMatch(lng === 'ru' ? /чате проекта тоже/ : /chat knows about the section too/);
      // Полоса не говорит, что чат кейсов не ведёт или ничего не запишет.
      expect(off).not.toMatch(/из чата кейсы не|ничего не запишет|chat does not|write nothing/i);
      expect(off).toMatch(
        lng === 'ru' ? /Чаты панели ведут кейсы/ : /panel’s chats keep the cases/,
      );
      expect(on).not.toMatch(/из чата|chat keeps/i);
    });
  }
});
