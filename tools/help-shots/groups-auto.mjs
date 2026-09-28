/**
 * Сценарий `groups/auto`: чтобы включалось само.
 *
 * Вход другой, чем у `bundle`: сюда приходят, когда щёлкать тумблер надоело.
 * Путь: привязка набора к проекту → строка «Когда уместна», по которой «Авто»
 * в чате выбирает группу → «Состав» привязанной группы с набором проекта →
 * «Создать группу» → «Сценарий»: группа из одних шагов, куда хук добавляется
 * шагом «Хук» (блока автоматизаций на странице больше нет).
 *
 * Порядка работы в форме больше нет — он во вкладке окна группы (сценарий
 * `groups/path`). Самого момента автоматического включения на экране нет и
 * быть не может: группу включает сервер перед запуском агента, и человек видит
 * только результат. Поэтому механизм показывает схема, а кадры — то, что
 * действительно видно.
 */
import { installGroupStubs, makeQuietGroupState, openGroup } from '../qa/group-stubs.mjs';
import { makeState, settings, panelShell, open } from './projects-stubs.mjs';

// Форма открывается поверх окна группы — снимаем верхнее.
const TOP_DIALOG = '[role="dialog"] >> nth=-1';

export async function shootAuto(browser, web, scenario) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });

  try {
    const state = makeState();
    // Сценарий-автоматизацию заводим в кадре: раздел начинается без неё.
    state.automations = [];

    await settings(page);
    await panelShell(page, state);
    // Путь, находки и выбор стороны — из общей подмены страницы групп; список
    // групп остаётся за состоянием этого сценария.
    await installGroupStubs(page, makeQuietGroupState(), { list: false });

    await open(page, web, '/groups');

    // ── 01. Привязка набора к проектам ───────────────────────────────────────
    // Правка живёт в шапке окна группы: щелчок по карточке, затем «Редактировать».
    const group = await openGroup(page, 'Тикеты магазина');
    await group.getByRole('button', { name: /^(Редактировать|Edit)$/ }).click();
    await page.waitForFunction(() => document.querySelectorAll('[role="dialog"]').length > 1);
    const dialog = page.locator(TOP_DIALOG);
    await page.waitForTimeout(1000);
    await scrollTo(page, dialog, /^(Проекты|Projects)$/);
    await scenario.shot(page, '01-binding', { clip: TOP_DIALOG, padding: 40 });

    // ── 02. «Когда уместна» — строка, по которой «Авто» выбирает группу ──────
    await dialog
      .getByLabel(/Когда уместна|When it fits/)
      .evaluate((node) => node.scrollIntoView({ block: 'center' }));
    await page.waitForTimeout(600);
    await scenario.shot(page, '02-when', { clip: TOP_DIALOG, padding: 40 });

    await dialog.getByRole('button', { name: /^(Отмена|Cancel)$/ }).click();
    await page.waitForFunction(() => document.querySelectorAll('[role="dialog"]').length === 1);
    await page.waitForTimeout(800);

    // ── 03. «Состав» привязанной группы: участники и набор проекта ───────────
    await group.getByRole('tab', { name: /^(Состав|Members)$/ }).click();
    await page.waitForTimeout(800);
    await scenario.shot(page, '03-details', { clip: TOP_DIALOG, padding: 24 });
    await page.mouse.move(0, 0);
    await page.keyboard.press('Escape');
    await page.waitForSelector('[role="dialog"]', { state: 'detached', timeout: 8000 });

    // ── 07. «Создать группу» → «Сценарий»: группа из одних шагов ─────────────
    // Номер кадра прежний: 04–06 (форма автоматизации) ушли вместе с блоком.
    await page
      .getByRole('button', { name: /^(Создать группу|Create group)$/ })
      .first()
      .click();
    await page
      .getByRole('dialog', { name: /^(Какую группу создать|Which group to create)$/ })
      .getByRole('button', { name: /^(Сценарий|Scenario)/ })
      .click();
    const create = page.getByRole('dialog', { name: /^(Новый сценарий|New scenario)$/ });
    await create.waitFor({ timeout: 8000 });
    await create.getByLabel(/^(Название|Name)$/).fill('Выпуск релиза магазина');
    await page.waitForTimeout(600);
    await scenario.shot(page, '07-scenario', { clip: TOP_DIALOG, padding: 40 });
  } finally {
    await page.close();
  }
}

/**
 * Прокрутить длинную форму к её блоку. Модалка прокручивается внутри себя, а
 * не страницей: у неё ограничена высота, и `scrollIntoView` окна тут ничего не
 * двигает.
 */
async function scrollTo(page, dialog, title) {
  await dialog
    .getByText(title, { exact: true })
    .first()
    .evaluate((node) => node.scrollIntoView({ block: 'start' }));
  await page.waitForTimeout(600);
}
