import { describe, expect, it } from 'vitest';
import type { PanelPendingAction, PanelTextParams } from '@agentdeck/contracts/panel-agent';
import { panelTextsEn } from '../../shared/config/i18n/panel-texts/texts.en';
import { panelTextsRu } from '../../shared/config/i18n/panel-texts/texts.ru';
import { cardFields, cardPreview, cardSummary } from './model';
import { panelText } from './panelText';

/**
 * Карточка агента на телефоне — словарём по коду, как окно панели. Раньше телефон
 * показывал русский запасной текст сервера всегда, и английский телефон читал
 * карточку по-русски.
 */
describe('текст карточки агента на телефоне', () => {
  it('код — своим словарём, с формой числа языка', () => {
    const params = { count: 3 };
    expect(panelText(panelTextsRu, 'ru', 'summary-draft-cases', params, 'запас')).toBe(
      'Записать 3 кейса из черновика в библиотеку тестов',
    );
    expect(panelText(panelTextsEn, 'en', 'label-file', undefined, 'Файл')).toBe('File');
  });

  // Hermes телефона (RN 0.86) несёт Intl без PluralRules: карточка с числом падала
  // TypeError и роняла всё приложение в ErrorBoundary, а в node тесты были зелёными.
  it('форма числа без Intl.PluralRules — как в Hermes телефона', () => {
    const intl = Intl as { PluralRules?: typeof Intl.PluralRules };
    const saved = intl.PluralRules;
    delete intl.PluralRules;
    try {
      const ru = (count: number) =>
        panelText(panelTextsRu, 'ru', 'summary-draft-cases', { count }, 'запас');
      expect([1, 3, 5, 11, 21, 22, 112].map(ru)).toEqual([
        'Записать 1 кейс из черновика в библиотеку тестов',
        'Записать 3 кейса из черновика в библиотеку тестов',
        'Записать 5 кейсов из черновика в библиотеку тестов',
        'Записать 11 кейсов из черновика в библиотеку тестов',
        'Записать 21 кейс из черновика в библиотеку тестов',
        'Записать 22 кейса из черновика в библиотеку тестов',
        'Записать 112 кейсов из черновика в библиотеку тестов',
      ]);
      expect(panelText(panelTextsEn, 'en', 'summary-draft-cases', { count: 1 }, 'x')).toBe(
        'Write 1 case from the draft into the test library',
      );
      expect(panelText(panelTextsEn, 'en', 'summary-draft-cases', { count: 2 }, 'x')).not.toBe(
        'Write 2 case from the draft into the test library',
      );
    } finally {
      intl.PluralRules = saved;
    }
  });

  it('без кода или с незнакомым кодом — русская строка сервера как есть', () => {
    expect(panelText(panelTextsEn, 'en', undefined, undefined, 'Файл')).toBe('Файл');
    expect(panelText(panelTextsEn, 'en', 'code-from-the-future', undefined, 'Файл')).toBe('Файл');
  });

  it('подпись поля с кодом переводится, значение-данные — нет', () => {
    const pending = {
      preview: {
        summary: 'Сводка',
        fields: [{ label: 'Файл', labelCode: 'label-file', value: 'C:/work/a.md' }],
      },
    } as unknown as PanelPendingAction;
    const fields = cardFields(pending, (code, params, fallback) =>
      panelText(panelTextsEn, 'en', code, params, fallback),
    );
    expect(fields).toEqual([{ label: 'File', value: 'C:/work/a.md', long: false }]);
  });
});

/**
 * Двуязычные данные карточки (заголовки шагов группы и сценария) — стороной языка
 * телефона. Кадр справки 27.09: английская карточка сценария шла с русскими
 * заголовками шагов, потому что сервер клал в `value` только ru.
 */
describe('двуязычные данные карточки на телефоне', () => {
  const bilingual = {
    preview: {
      summary: 'Добавить шаг «Скриншоты» в путь группы «Путь»',
      summaryCode: 'summary-group-step-add',
      summaryParams: { name: 'Путь', title: 'Скриншоты' },
      summaryParamsEn: { name: 'Путь', title: 'Screenshots' },
      fields: [
        {
          label: 'Шаги сценария',
          labelCode: 'label-scenario-steps',
          value: '1. Скриншоты',
          valueEn: '1. Screenshots',
        },
      ],
      diff: '+  "review #1: Скриншоты"',
      diffEn: '+  "review #1: Screenshots"',
    },
  } as unknown as PanelPendingAction;
  const legacy = {
    preview: {
      ...bilingual.preview,
      summaryParamsEn: undefined,
      diffEn: undefined,
      fields: [{ ...bilingual.preview.fields[0], valueEn: undefined }],
    },
  } as unknown as PanelPendingAction;

  const view = (pending: PanelPendingAction, language: 'ru' | 'en') => {
    const text = (
      code: string | undefined,
      params: PanelTextParams | undefined,
      fallback: string,
    ) =>
      panelText(language === 'en' ? panelTextsEn : panelTextsRu, language, code, params, fallback);
    return {
      summary: cardSummary(pending, text, language),
      value: cardFields(pending, text, language)[0]?.value,
      diff: cardPreview(pending, language).diff,
    };
  };

  it('английский телефон — английская сторона в сводке, поле и диффе', () => {
    expect(view(bilingual, 'en')).toEqual({
      summary: 'Add step “Screenshots” to the path of group “Путь”',
      value: '1. Screenshots',
      diff: '+  "review #1: Screenshots"',
    });
  });

  it('русский телефон — русская сторона', () => {
    expect(view(bilingual, 'ru')).toEqual({
      summary: 'Добавить шаг «Скриншоты» в путь группы «Путь»',
      value: '1. Скриншоты',
      diff: '+  "review #1: Скриншоты"',
    });
  });

  it('старая запись без английской стороны — как пришла', () => {
    expect(view(legacy, 'en')).toEqual({
      summary: 'Add step “Скриншоты” to the path of group “Путь”',
      value: '1. Скриншоты',
      diff: '+  "review #1: Скриншоты"',
    });
  });
});
