import i18next from 'i18next';
import { describe, expect, it } from 'vitest';
import {
  PANEL_PLURAL_FORMS,
  panelTextCodes,
  panelTextCountCodes,
  panelTextParams,
  requiredPluralForms,
  type PanelTextCode,
} from '@agentdeck/contracts/panel-agent';
import { templateParams } from '@agentdeck/contracts/server-messages';
import { panelTextsEn } from './texts.en';
import { panelTextsRu } from './texts.ru';

/**
 * Тексты карточки и следа агента по коду сервера: каждый код переведён на оба
 * языка ровно с объявленными подстановками и без лишних ключей. Код с `count`
 * вправе нести формы числа ключами i18next — тогда ВСЕ формы, которых требуют
 * правила языка; у кода без числа форм быть не может.
 */
describe('тексты агента панели по коду', () => {
  const dictionaries = { ru: panelTextsRu, en: panelTextsEn };

  for (const [language, dictionary] of Object.entries(dictionaries)) {
    it(`${language}: у каждого кода непустой текст или полный набор форм с объявленными подстановками`, () => {
      const entries = dictionary as Record<string, string | undefined>;
      const required = requiredPluralForms(language);
      const allowed = new Set<string>();
      const problems = panelTextCodes.flatMap((code: PanelTextCode) => {
        const declared = [...panelTextParams[code]].sort();
        const isCount = (panelTextCountCodes as readonly string[]).includes(code);
        const present = PANEL_PLURAL_FORMS.filter(
          (form) => entries[`${code}_${form}`] !== undefined,
        );
        const keys = present.length > 0 ? present.map((form) => `${code}_${form}`) : [code];
        if (present.length > 0) {
          if (!isCount) return [`${code}: формы числа у кода без count`];
          const missing = required.filter((form) => !present.includes(form));
          if (missing.length > 0) return [`${code}: нет форм ${missing.join(',')}`];
          if (entries[code] !== undefined) return [`${code}: и строка, и формы`];
        }
        keys.forEach((key) => allowed.add(key));
        return keys.flatMap((key) => {
          const text = entries[key];
          if (!text?.trim()) return [`${key}: нет перевода`];
          const used = [...new Set(templateParams(text))].sort();
          return JSON.stringify(used) === JSON.stringify(declared)
            ? []
            : [`${key}: подстановки ${used.join(',')} ≠ ${declared.join(',')}`];
        });
      });
      expect(problems).toEqual([]);
      expect(Object.keys(dictionary).sort()).toEqual([...allowed].sort());
    });
  }

  it('i18next выбирает форму числа по коду, как зовёт окно', async () => {
    const i18n = i18next.createInstance();
    await i18n.init({
      lng: 'ru',
      resources: {
        ru: { translation: { panelAgent: { text: panelTextsRu } } },
        en: { translation: { panelAgent: { text: panelTextsEn } } },
      },
      interpolation: { escapeValue: false },
    });
    const run = (count: number, lng: string) =>
      i18n.t('panelAgent.text.summary-run-tests-run', { count, lng });
    expect([1, 3, 5, 21].map((count) => run(count, 'ru'))).toEqual([
      'Запустить агента тестов: 1 кейс',
      'Запустить агента тестов: 3 кейса',
      'Запустить агента тестов: 5 кейсов',
      'Запустить агента тестов: 21 кейс',
    ]);
    expect([1, 2].map((count) => run(count, 'en'))).toEqual([
      'Start the test agent: 1 case',
      'Start the test agent: 2 cases',
    ]);
  });
});
