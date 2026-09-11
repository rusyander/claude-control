/**
 * Кадры раздела «Хуки»: два входа, два сценария.
 *
 * `first` — секции `hooks` в settings.json нет вовсе: пустой раздел, готовые
 * заготовки, собранный из заготовки хук и пакетное создание.
 * `living` — хуки уже стоят: список по событиям, порядок внутри события,
 * выключение, пропавший файл скрипта и запись из локального файла настроек,
 * которую панель показывает, но не правит.
 *
 * Подмен нет: панель разбирает настоящий settings.json одноразового каталога,
 * создаёт настоящие файлы в `hooks/` и пишет туда же.
 */
import { clearHooks, restoreHooks } from './config-fixture.mjs';
import { openSection, closeModal } from './config-stubs.mjs';

export async function shootHooksFirst(browser, web, scenario, home) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 950 } });

  try {
    clearHooks(home);

    // ── 01. Пустой раздел ────────────────────────────────────────────────────
    await openSection(page, web, '/hooks', 2000);
    await scenario.shot(page, '01-empty');

    // ── 02. Форма и готовые хуки ─────────────────────────────────────────────
    // Событие выбирается списком, и рядом сразу написано, когда оно случается
    // и может ли остановить действие.
    await page
      .getByRole('button', { name: /^(Добавить хук|Add hook)$/ })
      .first()
      .click();
    await page.waitForTimeout(1500);
    await scenario.shot(page, '02-form', { clip: '[role="dialog"]', padding: 24 });

    // ── 03. Заготовка заполнила поля ─────────────────────────────────────────
    // Имя файла меняем: заготовка предлагает `destructive-guard`, а такой файл
    // в каталоге уже есть — сохранение перезаписало бы его.
    await page
      .getByRole('button', { name: 'Страж разрушительных команд', exact: true })
      .first()
      .click();
    await page.waitForTimeout(1000);
    await page.getByLabel(/^(Имя файла хука|Hook file name)$/).fill('no-force-push');
    await page
      .getByLabel(/^(Что перехватывать|What to intercept)$/)
      .fill('git push --force, git reset --hard');
    await page.waitForTimeout(600);
    await scenario.shot(page, '03-preset', { clip: '[role="dialog"]', padding: 24 });

    // ── 04. Хук в списке ─────────────────────────────────────────────────────
    // Файл создан панелью, команда запуска подставлена абсолютным путём.
    await page
      .getByRole('button', { name: /^(Сохранить|Save)$/ })
      .first()
      .click();
    await page.waitForTimeout(2500);
    await scenario.shot(page, '04-card');

    // ── 05. Несколько сразу ──────────────────────────────────────────────────
    await page
      .getByRole('button', { name: /^(Добавить хук|Add hook)$/ })
      .first()
      .click();
    await page.waitForTimeout(1200);
    await page
      .getByRole('button', { name: /^(Несколько сразу|Several at once)$/ })
      .first()
      .click();
    await page.waitForTimeout(1000);
    await page
      .getByRole('button', { name: /^Страж секретов/ })
      .first()
      .click();
    await page
      .getByRole('button', { name: /^Чек-поинт перед сжатием/ })
      .first()
      .click();
    await page.waitForTimeout(600);
    await scenario.shot(page, '05-bulk', { clip: '[role="dialog"]', padding: 24 });
    await closeModal(page);
  } finally {
    await page.close();
  }
}

export async function shootHooksLiving(browser, web, scenario, home) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1050 } });

  try {
    restoreHooks(home);

    // ── 01. Список по событиям ───────────────────────────────────────────────
    // Группировка по событию — это и есть ответ на «что происходит в этой точке
    // жизненного цикла»: хуки одного события идут сверху вниз.
    await openSection(page, web, '/hooks', 2500);
    await scenario.shot(page, '01-list');

    // ── 02. Запись локального файла настроек ─────────────────────────────────
    // У хука из settings.local.json нет тумблера: панель в тот файл не пишет по
    // своей инициативе. Удаление там возможно, и диалог прямо называет, из
    // какого файла запись уйдёт и что файл скрипта останется на диске.
    await page
      .getByRole('button', { name: /^(Удалить|Delete): SessionEnd$/ })
      .first()
      .click();
    await page.waitForTimeout(1500);
    await scenario.shot(page, '02-local', { clip: '[role="dialog"]', padding: 24 });
    await closeModal(page);

    // ── 03. Порядок внутри события ───────────────────────────────────────────
    // Хуки одного события выполняются сверху вниз, и стрелки меняют именно этот
    // порядок в файле — а не порядок событий между собой.
    await page
      .getByRole('button', { name: /^(Ниже в порядке события|Move down in the event order)$/ })
      .first()
      .click();
    await page.waitForTimeout(2500);
    await scenario.shot(page, '03-order');

    // ── 04. Хук выключен ─────────────────────────────────────────────────────
    // Выключение — это удаление записи из settings.json; текст хука панель
    // помнит у себя и возвращает обратно тем же тумблером.
    await page.getByRole('switch').first().click();
    await page.waitForTimeout(2500);
    await scenario.shot(page, '04-off');

    // ── 05. Правка команды ───────────────────────────────────────────────────
    // У существующего хука в файле лежит только команда — её и правят, вместе с
    // таймаутом; заготовки здесь не показываются.
    await page
      .getByRole('button', { name: /^(Редактировать|Edit): PostToolUse/ })
      .first()
      .click();
    await page.waitForTimeout(2000);
    await scenario.shot(page, '05-edit', { clip: '[role="dialog"]', padding: 24 });
    await closeModal(page);
  } finally {
    await page.close();
  }
}
