/**
 * Сценарии раздела «MCP-серверы»: `mcp/connect` и `mcp/trouble`.
 *
 * Делятся по входу. В первый приходят с документацией чужого сервера в руках и
 * вопросом «куда это вставить»; во второй — когда сервер уже добавлен, но на
 * карточке красная плашка, и вопрос ровно один: почему.
 *
 * Оба исхода настоящие. Кадр «Отвечает: 5 инструментов» снят после НАСТОЯЩЕГО
 * рукопожатия MCP с процессом `demo-mcp-server.mjs`: проба панели — официальный
 * клиент SDK, и подсунуть ему готовый ответ можно было бы только подменив ответ
 * сервера панели, то есть доказав разметку карточки вместо связи. Четыре причины
 * отказа тоже не нарисованы: `warehouse` — команда, которой нет в PATH;
 * `billing` — ссылка на переменную, которой нет в файлах; он же после появления
 * переменной — отвергнутый токен; `crm` — 401 от процесса, который на всё
 * отвечает 401.
 */
import {
  ORDERS_SERVER,
  closeModal,
  mcpServers,
  openSection,
  writeMcpConfig,
  writeSecrets,
  writeSettings,
} from './access-fixture.mjs';

/**
 * Карточка сервера как область кадра. Имя сервера — единственное, что на ней
 * заведомо уникально; от него и поднимаемся к самой карточке. Классы взяты из
 * css-модулей, их имена собираются при сборке, и селектор по ним держался бы
 * ровно до следующего обновления Vite.
 */
const card = (name) => `xpath=//span[normalize-space(text())="${name}"]/ancestor::div[4]`;

/**
 * Нажать «Проверить» на карточке сервера и дождаться ответа пробы. Ожидание
 * щедрое: у stdio бюджет рукопожатия — 45 секунд, а сетевой сервер за 401 успевает
 * сходить ещё и за описанием своей авторизации.
 */
async function check(page, name, wait = 12_000) {
  await page
    .locator(card(name))
    .getByRole('button', { name: /^(Проверить|Check)$/ })
    .first()
    .click();
  await page.waitForTimeout(wait);
}

export async function shootConnect(browser, web, scenario) {
  // Окна форм этого раздела высокие: заготовки, семь полей и колонка помощника.
  // Область кадра обрезается по окну браузера, и низкое окно срезало бы низ формы.
  const page = await browser.newPage({ viewport: { width: 1400, height: 1200 } });

  try {
    // Ни одного сервера: то состояние, в котором раздел пуст, а человек держит
    // в руках чужую документацию.
    writeSettings({});
    writeSecrets(undefined);
    writeMcpConfig({});

    // ── 01. Пустой раздел ────────────────────────────────────────────────────
    await openSection(page, web, '/mcp');
    await scenario.shot(page, '01-empty');

    // ── 02. Конструктор ──────────────────────────────────────────────────────
    await page
      .getByRole('button', { name: /^(Добавить сервер|Add server)$/ })
      .first()
      .click();
    await page.waitForTimeout(1200);
    await page.getByLabel(/^(Имя сервера|Server name)$/).fill('orders');
    await page.getByLabel(/^(Команда запуска|Start command)$/).fill('node');
    await page.getByLabel(/^(Аргументы|Arguments)$/).fill(ORDERS_SERVER);
    await page.waitForTimeout(600);
    await scenario.shot(page, '02-form-presets', { clip: '[role="dialog"]', padding: 24 });
    await page
      .getByRole('button', { name: /^(Сохранить|Save)$/ })
      .first()
      .click();
    await page.waitForTimeout(2000);

    // ── 03. Вставка блока из документации ────────────────────────────────────
    await page
      .getByRole('button', { name: /^(Добавить сервер|Add server)$/ })
      .first()
      .click();
    await page.waitForTimeout(1000);
    await page
      .getByRole('button', { name: /^(Несколько из JSON|Several from JSON)$/ })
      .first()
      .click();
    await page.waitForTimeout(600);
    await page
      .locator('[role="dialog"] textarea')
      .first()
      .fill(
        JSON.stringify(
          {
            mcpServers: {
              warehouse: { command: 'warehouse-mcp', args: ['--stdio'] },
              crm: { type: 'http', url: 'http://127.0.0.1:5196/mcp' },
            },
          },
          null,
          2,
        ),
      );
    await page.waitForTimeout(1000);
    await scenario.shot(page, '03-import', { clip: '[role="dialog"]', padding: 24 });
    await page
      .getByRole('button', { name: /^(Добавить все|Add all)/ })
      .first()
      .click();
    await page.waitForTimeout(2500);

    // ── 04. Сервер есть, связь не проверялась ────────────────────────────────
    await openSection(page, web, '/mcp');
    await scenario.shot(page, '04-card-unknown');

    // ── 05. Проверка связи ───────────────────────────────────────────────────
    await check(page, 'orders');
    await scenario.shot(page, '05-connected', { clip: card('orders'), padding: 20 });

    // ── 06. Инструменты → права ──────────────────────────────────────────────
    // Окно спрашивает сервер заново и превращает отмеченное в правила
    // `mcp__orders__<инструмент>`: это тот же раздел «Права», вход только другой.
    await page
      .locator(card('orders'))
      .getByRole('button', { name: /^(Инструменты|Tools)$/ })
      .click();
    await page.waitForTimeout(5000);
    for (const tool of ['list_orders', 'order_details', 'export_orders']) {
      await page.locator(`[role="dialog"] label:has-text("${tool}") input`).first().check();
    }
    await page.waitForTimeout(600);
    await scenario.shot(page, '06-tools', { clip: '[role="dialog"]', padding: 24 });
    await closeModal(page);
  } finally {
    await page.close();
  }
}

export async function shootTrouble(browser, web, scenario, { oauthPort }) {
  const page = await browser.newPage({ viewport: { width: 1400, height: 1200 } });

  try {
    // Условие задачи: четыре сервера уже записаны, переменных нет ни одной.
    writeSettings({});
    writeSecrets(undefined);
    writeMcpConfig({ mcpServers: mcpServers({ oauthPort }) });

    await openSection(page, web, '/mcp');

    // ── 01. Команды нет на машине ────────────────────────────────────────────
    await check(page, 'warehouse');
    await scenario.shot(page, '01-failed', { clip: card('warehouse'), padding: 20 });

    // ── 02. Ссылка на переменную, которой нет ────────────────────────────────
    // Панель отказывается ДО соединения и называет переменную: без этого тот же
    // сервер ответил бы 401 на строку «Bearer ${BILLING_TOKEN}», и карточка
    // отправила бы человека авторизовываться вместо того, чтобы завести токен.
    await check(page, 'billing');
    await scenario.shot(page, '02-missing-var', { clip: card('billing'), padding: 20 });

    // ── 03. Токен есть, но сервер его не принял ──────────────────────────────
    writeSecrets('# Токен биллинга, выдаёт администратор системы\nBILLING_TOKEN=blg_9d41c7e2\n');
    await openSection(page, web, '/mcp');
    await check(page, 'billing');
    await scenario.shot(page, '03-token-rejected', { clip: card('billing'), padding: 20 });

    // ── 04. 401 без своего заголовка — это приглашение войти ─────────────────
    await check(page, 'crm');
    await scenario.shot(page, '04-oauth', { clip: card('crm'), padding: 20 });

    // ── 05. Выключенный сервер ───────────────────────────────────────────────
    // Выключение переносит запись в `mcpServersDisabled` того же файла: Claude
    // Code такой сервер не запустит, а панель помнит его настройки целиком.
    await page
      .getByLabel(/^(Включено|Enabled): warehouse$/)
      .first()
      .click();
    await page.waitForTimeout(2000);
    await scenario.shot(page, '05-disabled', { clip: card('warehouse'), padding: 20 });

    // ── 06. Где живёт токен сетевого сервера ─────────────────────────────────
    await page
      .locator(card('billing'))
      .getByLabel(/^(Редактировать|Edit): billing$/)
      .first()
      .click();
    await page.waitForTimeout(1500);
    await scenario.shot(page, '06-headers', { clip: '[role="dialog"]', padding: 24 });
    await closeModal(page);
  } finally {
    await page.close();
  }
}
