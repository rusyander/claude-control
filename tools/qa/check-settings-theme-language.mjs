/**
 * Кейс settings-models-001: тема и язык из «Настройки → Общие» применяются
 * сразу (без перезагрузки) и переживают F5. Параметры кейса — тема
 * «Светлая»/«Тёмная» × язык «Русский»/«English»: здесь проходятся все четыре
 * сочетания подряд.
 *
 * «Без перезагрузки» доказывается меткой в `window`: она живёт, пока документ
 * тот же. «Цвета меняются» — вычисленный фон `body`, а не только атрибут темы.
 * «Хранится» — `state.json` стенда на диске и повторное чтение после F5.
 *
 * Запуск: `node tools/qa/check-settings-theme-language.mjs` (стенд поднимается сам).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { runOnStand, wait } from './throwaway-stand.mjs';

const THEME_LABEL = {
  ru: { light: 'Светлая', dark: 'Тёмная' },
  en: { light: 'Light', dark: 'Dark' },
};
// У пункта «Правила» в имени ещё и счётчик («Правила 0») — поэтому начало имени.
const NAV_RULES = { ru: 'Правила', en: 'Rules' };
/** Ждать условие до 5 с: тема применяется, когда настройка сохранена, — около секунды. */
const until = async (probe) => {
  for (let step = 0; step < 25; step += 1) {
    if (await probe()) return true;
    await wait(200);
  }
  return false;
};
const LANGUAGE_BUTTON = { ru: 'Русский', en: 'English' };
const COMBOS = [
  ['dark', 'ru'],
  ['dark', 'en'],
  ['light', 'en'],
  ['light', 'ru'],
];

await runOnStand({ label: 'settings-theme-language' }, async (stand, check) => {
  const stored = () =>
    JSON.parse(readFileSync(join(stand.cfg, 'agentdeck', 'state.json'), 'utf8')).settings ?? {};
  const browser = await chromium.launch();
  try {
    const page = await stand.newPage(browser, { height: 1000 });
    await page.goto(`${stand.webUrl}/settings`, { waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: 'Светлая', exact: true }).waitFor({ timeout: 30_000 });
    let language = 'ru';

    const theme = () => page.evaluate(() => document.documentElement.dataset.theme);
    const background = () => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    const navHas = (lang) =>
      page
        .locator('nav')
        .first()
        .getByRole('link', { name: new RegExp(`^${NAV_RULES[lang]}(\\s|$)`) })
        .count();

    for (const [wantTheme, wantLanguage] of COMBOS) {
      const tag = `${wantTheme}+${wantLanguage}`;
      await page.evaluate(() => {
        window.__sameDocument = true;
      });
      const colorBefore = await background();
      const themeBefore = await theme();
      await page
        .getByRole('button', { name: THEME_LABEL[language][wantTheme], exact: true })
        .click();
      await until(async () => (await theme()) === wantTheme);
      check(
        `${tag}: тема применилась (${themeBefore} → ${wantTheme})`,
        (await theme()) === wantTheme,
        String(await theme()),
      );
      if (themeBefore !== wantTheme) {
        check(
          `${tag}: фон страницы сменился`,
          (await background()) !== colorBefore,
          `${colorBefore} → ${await background()}`,
        );
      }
      await page.getByRole('button', { name: LANGUAGE_BUTTON[wantLanguage], exact: true }).click();
      await until(async () => (await navHas(wantLanguage)) > 0);
      language = wantLanguage;
      check(`${tag}: боковая панель на выбранном языке`, (await navHas(wantLanguage)) > 0);
      check(
        `${tag}: и без подписей другого языка`,
        (await navHas(wantLanguage === 'ru' ? 'en' : 'ru')) === 0,
      );
      check(
        `${tag}: всё без перезагрузки`,
        await page.evaluate(() => window.__sameDocument === true),
      );
      const saved = stored();
      check(
        `${tag}: в state.json тема и язык`,
        saved.theme === wantTheme && saved.language === wantLanguage,
        JSON.stringify({ theme: saved.theme, language: saved.language }),
      );

      await page.reload({ waitUntil: 'domcontentloaded' });
      await page
        .getByRole('button', { name: THEME_LABEL[language][wantTheme], exact: true })
        .waitFor({ timeout: 30_000 });
      await wait(500);
      check(`${tag}: после F5 тема та же`, (await theme()) === wantTheme, String(await theme()));
      check(`${tag}: после F5 язык тот же`, (await navHas(wantLanguage)) > 0);
      check(
        `${tag}: после F5 кнопки отмечены выбранными`,
        (await page
          .getByRole('button', { name: THEME_LABEL[language][wantTheme], exact: true })
          .getAttribute('aria-pressed')) === 'true' &&
          (await page
            .getByRole('button', { name: LANGUAGE_BUTTON[wantLanguage], exact: true })
            .getAttribute('aria-pressed')) === 'true',
      );
    }
    check('страница без необработанных ошибок', page.errors.length === 0, page.errors.join(' | '));
  } finally {
    await browser.close();
  }
});
