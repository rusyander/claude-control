/**
 * Сценарий `prompts/library` — каталог промптов приложения.
 *
 * Кадры снимаются НАСТОЯЩЕЙ правкой: панель сохраняет текст файлом в каталоге
 * данных одноразового стенда, показывает отметку «Изменён» и стирает файл по
 * кнопке сброса. Нарисовать эти четыре состояния было бы нечестно — весь раздел
 * ровно про то, что правка живёт отдельно от встроенного текста и снимается
 * одной кнопкой.
 *
 * Правка вписывается ПЕРВОЙ строкой, а не заменяет текст целиком: в кадре должно
 * быть видно, что встроенный текст остался на месте, а человек добавил к нему
 * своё.
 */
import { shotLanguage } from './kit.mjs';
import { openSettingsTab, card, shotCard } from './access-providers-fixture.mjs';

/** Карточка вкладки. Английский близнец заголовка живёт в `TITLE_EN` фикстуры. */
const CARD = card('Промпты приложения');

/** Промпт, который открывается в кадрах: у него самая понятная в справке роль. */
const PROMPT = { ru: 'Агент через контур', en: 'Agent behind a contour' };

/** Строка правки. Пишется на языке прогона: кадр — это интерфейс целиком. */
const EDIT = {
  ru: '# Правка компании: отвечай по-русски и не предлагай ставить пакеты.',
  en: '# Company edit: answer in English and never offer to install packages.',
};

export async function shootLibrary(browser, web, scenario) {
  // Окно выше обычного: с открытым промптом карточка — это список из пяти строк
  // плюс поле на шестнадцать строк, и в кадр 1000 точек она не помещается.
  const page = await browser.newPage({ viewport: { width: 1400, height: 1250 } });
  const lang = shotLanguage();
  const name = PROMPT[lang] ?? PROMPT.ru;

  try {
    // ── 01. Пять текстов списком ─────────────────────────────────────────────
    await openSettingsTab(page, web, 'prompts', 2500);
    await shotCard(scenario, page, '01-list', CARD);

    // ── 02. Встроенный текст целиком ─────────────────────────────────────────
    // Кнопка берётся ОТ ИМЕНИ промпта, а не по порядковому номеру: порядок
    // каталога — это порядок чтения, и он меняется при добавлении промпта.
    await page
      .locator(`xpath=//*[normalize-space(text())="${name}"]/ancestor::div[2]//button`)
      .first()
      .click();
    await page.waitForTimeout(1500);
    await shotCard(scenario, page, '02-builtin', CARD);

    // ── 03. Сохранённая правка ───────────────────────────────────────────────
    const editor = page.locator(CARD).locator('textarea').first();
    const builtin = await editor.inputValue();
    await editor.fill(`${EDIT[lang] ?? EDIT.ru}\n\n${builtin}`);
    await page.waitForTimeout(400);
    await page
      .locator(CARD)
      .getByRole('button', { name: /^(Сохранить|Save)$/ })
      .first()
      .click();
    await page.waitForTimeout(2000);
    // После `fill` каретка стоит в конце, и поле показывает хвост встроенного
    // текста — а кадр нужен ради первой строки, той самой правки. Перематываем
    // поле к началу.
    await editor.evaluate((element) => {
      element.scrollTop = 0;
    });
    await page.waitForTimeout(300);
    await shotCard(scenario, page, '03-edited', CARD);

    // ── 04. Возврат к встроенному ────────────────────────────────────────────
    await page
      .locator(CARD)
      .getByRole('button', { name: /^(Сбросить к встроенному|Reset to built-in)$/ })
      .first()
      .click();
    await page.waitForTimeout(2000);
    await shotCard(scenario, page, '04-reset', CARD);
  } finally {
    await page.close();
  }
}
