/**
 * Кадры раздела «Скрипты»: два входа, два сценария.
 *
 * `files` — файлы в `hooks/` уже лежат: список с пометками «Используется» /
 * «Не привязан» / «Тест», содержимое файла, промах поиска и предупреждение при
 * удалении файла, который вызывает хук.
 * `new` — файла ещё нет: готовые каркасы, заполненный код и пакетное создание.
 *
 * Подмен нет: панель читает настоящую папку `hooks/` одноразового каталога и
 * пишет в неё же, считая привязку к событиям по настоящему settings.json.
 */
import { restoreHooks } from './config-fixture.mjs';
import { openSection, closeModal } from './config-stubs.mjs';

export async function shootScriptsFiles(browser, web, scenario, home) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 950 } });

  try {
    restoreHooks(home);

    // ── 01. Все файлы папки ──────────────────────────────────────────────────
    // Пометка «Используется» — про привязку к хуку, и она транзитивна: общий
    // модуль, который импортирует привязанный скрипт, забытым не считается.
    await openSection(page, web, '/scripts', 2500);
    await scenario.shot(page, '01-list');

    // ── 02. Содержимое файла ─────────────────────────────────────────────────
    await page.getByRole('button', { name: 'shared/input.mjs' }).first().click();
    await page.waitForTimeout(2000);
    await scenario.shot(page, '02-content');
    await page.getByRole('button', { name: 'shared/input.mjs' }).first().click();
    await page.waitForTimeout(800);

    // ── 03. Поиск не нашёл ───────────────────────────────────────────────────
    await page
      .getByRole('searchbox', { name: /^(Поиск по скриптам|Search scripts)$/ })
      .first()
      .fill('миграции');
    await page.waitForTimeout(1200);
    await scenario.shot(page, '03-search');
    await page
      .getByRole('searchbox', { name: /^(Поиск по скриптам|Search scripts)$/ })
      .first()
      .fill('');
    await page.waitForTimeout(1000);

    // ── 04. Удаление привязанного файла ──────────────────────────────────────
    // Диалог говорит последствие, а не «точно удалить?»: хук останется в
    // settings.json и перестанет работать, потому что файла не найдётся.
    await page
      .getByRole('button', { name: /^(Удалить|Delete): destructive-guard\.mjs$/ })
      .first()
      .click();
    await page.waitForTimeout(1500);
    await scenario.shot(page, '04-delete', { clip: '[role="dialog"]', padding: 24 });
    await closeModal(page);
  } finally {
    await page.close();
  }
}

export async function shootScriptsNew(browser, web, scenario) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 950 } });

  try {
    // ── 01. Готовые каркасы ──────────────────────────────────────────────────
    await openSection(page, web, '/scripts', 2500);
    await page
      .getByRole('button', { name: /^(Добавить скрипт|Add script)$/ })
      .first()
      .click();
    await page.waitForTimeout(1500);
    await scenario.shot(page, '01-form', { clip: '[role="dialog"]', padding: 24 });

    // ── 02. Каркас подставил код и имя ───────────────────────────────────────
    // Имя файла подставляется только в пустое поле: введённое руками не трогают.
    // Пресет «Страж команды» — заготовка панели, а не переведённый текст: он
    // одинаков в обеих съёмках.
    await page.getByRole('button', { name: 'Страж команды', exact: true }).first().click();
    await page.waitForTimeout(1000);
    await page.getByLabel(/^(Имя файла|File name)$/).fill('no-secrets.mjs');
    await page.waitForTimeout(600);
    await scenario.shot(page, '02-template', { clip: '[role="dialog"]', padding: 24 });

    // ── 03. Несколько сразу ──────────────────────────────────────────────────
    await page
      .getByRole('button', { name: /^(Несколько сразу|Several at once)$/ })
      .first()
      .click();
    await page.waitForTimeout(1200);
    await page
      .getByRole('button', { name: /^Формат при сохранении/ })
      .first()
      .click();
    await page
      .getByRole('button', { name: /^Брифинг при старте/ })
      .first()
      .click();
    await page.waitForTimeout(600);
    await scenario.shot(page, '03-bulk', { clip: '[role="dialog"]', padding: 24 });
    await closeModal(page);
  } finally {
    await page.close();
  }
}
