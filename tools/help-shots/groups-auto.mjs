/**
 * Сценарий `groups/auto`: чтобы включалось само.
 *
 * Вход другой, чем у `bundle`: сюда приходят, когда щёлкать тумблер надоело.
 * Путь: привязка набора к проекту → порядок работы шагами и триггер по тексту
 * запроса → карточка привязанного набора → скилл, в который панель превратила
 * шаги → сценарий-автоматизация и хук, которым он стал в settings.json.
 *
 * Самого момента автоматического включения на экране нет и быть не может:
 * группу включает сервер перед запуском агента, и человек видит только
 * результат — тумблер, который уже включён. Поэтому механизм показывает схема,
 * а кадры показывают то, что действительно видно: привязку, шаги, скилл и хук.
 */
import { makeState, settings, panelShell, open } from './projects-stubs.mjs';

export async function shootAuto(browser, web, scenario) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });

  try {
    const state = makeState();
    // Сценарий-автоматизацию заводим в кадре: раздел начинается без неё.
    state.automations = [];

    await settings(page);
    await panelShell(page, state);

    await open(page, web, '/groups');

    // ── 01. Привязка набора к проектам ───────────────────────────────────────
    await page
      .getByRole('button', { name: /^(Редактировать|Edit): Тикеты магазина/ })
      .first()
      .click();
    await page.waitForSelector('[role="dialog"]');
    const dialog = page.locator('[role="dialog"]').first();
    await page.waitForTimeout(1000);
    await scrollTo(page, dialog, /^(Проекты|Projects)$/);
    await scenario.shot(page, '01-binding', { clip: '[role="dialog"]', padding: 40 });

    // ── 02. Порядок работы шагами ────────────────────────────────────────────
    await scrollTo(page, dialog, /^(Порядок работы|Working order)$/);
    await scenario.shot(page, '02-steps', { clip: '[role="dialog"]', padding: 40 });

    // ── 03. Негодное выражение триггера ──────────────────────────────────────
    // Панель проверяет выражение прямо в форме: сломанное упало бы внутри хука
    // на каждом запросе, и разбирать это пришлось бы уже по стеку в чужом чате.
    await page.getByLabel(/Триггер по тексту запроса|Trigger on the prompt text/).fill('PRJ-(\\d+');
    await page.waitForTimeout(500);
    await scrollTo(page, dialog, /^(Порядок работы|Working order)$/);
    await scenario.shot(page, '03-trigger-error', { clip: '[role="dialog"]', padding: 40 });

    // Форму закрываем отменой: сценарий ничего не сохраняет, а сломанное
    // выражение тем более не должно доехать до состояния панели.
    await page.getByRole('button', { name: /^(Отмена|Cancel)$/ }).click();
    await page.waitForSelector('[role="dialog"]', { state: 'detached', timeout: 8000 });
    await page.waitForTimeout(800);

    // ── 04. Карточка привязанного набора ─────────────────────────────────────
    await scenario.shot(page, '04-card');

    // ── 05. Скилл, в который превратились шаги ───────────────────────────────
    await open(page, web, '/skills');
    await scenario.shot(page, '05-skill');

    // ── 06. Сценарий-автоматизация: когда и что сделать ──────────────────────
    await open(page, web, '/groups');
    await page
      .getByRole('button', { name: /^(Создать сценарий|Create automation)$/ })
      .first()
      .click();
    await page.waitForSelector('[role="dialog"]');
    await page
      .getByLabel(/^(Название сценария|Automation name)$/)
      .fill('Проверка типов после правки');
    await page.getByLabel(/^(Фильтр|Matcher)$/).fill('Edit');
    await page.getByLabel(/^(Команда|Command)$/).fill('pnpm type-check');
    await page.waitForTimeout(800);
    await scenario.shot(page, '06-automation-form', { clip: '[role="dialog"]', padding: 40 });

    await page.getByRole('button', { name: /^(Сохранить|Save)$/ }).click();
    await page.waitForSelector('[role="dialog"]', { state: 'detached', timeout: 8000 });
    await page.waitForTimeout(1200);

    // ── 07. Сценарий в списке ────────────────────────────────────────────────
    await page.locator('main').evaluate((node) => node.scrollTo(0, node.scrollHeight));
    await page.waitForTimeout(600);
    await scenario.shot(page, '07-automation-card');

    // ── 08. Хуки, которые панель собрала сама ────────────────────────────────
    await open(page, web, '/hooks');
    await scenario.shot(page, '08-hooks');
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
