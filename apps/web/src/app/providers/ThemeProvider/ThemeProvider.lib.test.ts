import { describe, expect, it } from 'vitest';
import { applyLanguage, type LanguageSwitch } from './ThemeProvider.lib';

/** i18next с управляемой загрузкой словаря: смена языка завершается по `finish()`. */
function slowI18n(initial: string) {
  let finish = (): void => {};
  const i18n: LanguageSwitch = {
    language: initial,
    changeLanguage(language) {
      return new Promise((resolve) => {
        finish = () => {
          i18n.language = language;
          resolve(undefined);
        };
      });
    },
  };
  return { i18n, finish: () => finish() };
}

describe('applyLanguage', () => {
  // `lang` на корне — обещание «интерфейс на этом языке»: по нему читалка экрана выбирает
  // произношение, а съёмка справки проверяет язык кадра. Английский словарь — отдельный
  // чанк; пока он едет, текст русский, и `lang="en"` в это время врал (dlp/gate 03-hook
  // dark-en прошёл проверку языка с русским кадром).
  it('lang меняется только после того, как словарь нового языка загружен', async () => {
    const root = { lang: 'ru' };
    const { i18n, finish } = slowI18n('ru');
    const done = applyLanguage(i18n, 'en', root);
    expect(root.lang).toBe('ru');
    finish();
    await done;
    expect(root.lang).toBe('en');
  });

  it('язык уже тот — lang ставится сразу, без смены', async () => {
    const root = { lang: '' };
    const { i18n } = slowI18n('en');
    await applyLanguage(i18n, 'en', root);
    expect(root.lang).toBe('en');
  });

  // Быстрое ru → en → ru: запоздавший ответ первой смены не должен перетереть lang второй.
  it('запоздавшая смена не перетирает lang более новой', async () => {
    const root = { lang: 'ru' };
    const first = slowI18n('ru');
    const pending = applyLanguage(first.i18n, 'en', root);
    first.i18n.language = 'ru';
    await applyLanguage(first.i18n, 'ru', root);
    first.finish();
    await pending;
    expect(root.lang).toBe('ru');
  });
});
