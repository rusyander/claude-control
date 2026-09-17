/**
 * Сценарии раздела «Агент панели»: `panelAgent/first` и `panelAgent/guards`.
 *
 * Каждый шаг — настоящая реплика в настоящем окне: съёмка печатает её в поле,
 * панель запускает фальшивую модель, та зовёт действия панели через переходник,
 * и карточка приходит тем же кадром `/api/events`, что и у живого агента.
 * Решение по карточке — клик (или Enter) в окне, как у человека.
 *
 * Состояние, которое по сюжету меняет «кто-то другой» (файл правил, сломанные
 * правила маскирования, другой CLI), меняется на диске стенда или ручкой панели —
 * тем же путём, каким это случилось бы у человека.
 *
 * Единственная подмена ответа сервера — кадры `guards/09…12`: отказы до запуска
 * (`cli_not_found`, `endpoint_unsupported`, `contour_unreachable`, `busy`)
 * требуют сломать стенд (убрать CLI из PATH, завести эндпоинт с ключом, контур
 * без шлюза, второй ход из другой вкладки). Ответ `POST /api/agent/run` там
 * подменён тем же телом 409, что шлёт маршрут; текст отказа окно берёт из
 * своего словаря по коду. `timeout` кадра не имеет: потолок хода — константа
 * (`PANEL_AGENT_RUN_TIMEOUT_MS`, ожидание карточки + 5 мин), короткий потолок
 * передаётся только тестам маршрута, а подмена его текстом показала бы то, чего
 * панель сама не рисовала.
 */
import { rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';

const WINDOW = '[data-panel-agent-window]';
const lang = () => (process.env.GUIDE_LANG === 'en' ? 'en' : 'ru');
const t = (ru, en) => (lang() === 'en' ? en : ru);

async function openSection(page, web, path, pause = 2500) {
  await page.goto(`${web}${path}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('nav');
  await page.waitForTimeout(pause);
}

async function openAgent(page, timeout = 30_000) {
  if (await page.locator(WINDOW).count()) return;
  await page
    .getByRole('button', { name: /^(Агент панели|Panel agent)/ })
    .first()
    .click({ timeout });
  await page.waitForSelector(WINDOW);
  await page.waitForTimeout(900);
}

async function view(page, ru, en) {
  await page
    .locator(WINDOW)
    .getByRole('button', { name: t(ru, en), exact: true })
    .click();
  await page.waitForTimeout(1500);
}

/** Реплика агенту и ожидание, пока ход дойдёт до карточки или до конца. */
async function send(page, text, { card = false, leaveInput = false } = {}) {
  await page.locator('[data-agent-input]').fill(text);
  await page.keyboard.press('Enter');
  // Человек отправил и отвёл руки от поля: только тогда карточка вправе забрать
  // фокус — пока он печатает, она его не трогает (ревью B1).
  if (leaveInput) await page.evaluate(() => document.activeElement?.blur());
  if (card) {
    await page.waitForSelector('[data-agent-pending]', { timeout: 40_000 });
    await page.waitForTimeout(1500);
  } else {
    await turnOver(page);
  }
}

/** Ход закончен: кнопки «Остановить» больше нет. */
async function turnOver(page) {
  await page.waitForTimeout(800);
  await page
    .locator(WINDOW)
    .getByRole('button', { name: /^(Остановить|Stop)$/ })
    .waitFor({ state: 'detached', timeout: 40_000 });
  await page.waitForTimeout(1200);
}

async function newConversation(page) {
  const button = page
    .locator(WINDOW)
    .getByRole('button', { name: /^(Новый разговор|New conversation)$/ });
  if (await button.count()) await button.click();
  // Курсор уводится с кнопки: иначе кадр ловит её подсветку при наведении.
  await page.mouse.move(1, 1);
  await page.waitForTimeout(600);
}

async function patchSettings(panel, patch) {
  const response = await fetch(`${panel}/api/settings`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(patch),
  });
  if (!response.ok) throw new Error(`PATCH /api/settings: ${response.status}`);
}

const windowShot = (scenario, page, id) => scenario.shot(page, id, { clip: WINDOW, padding: 0 });

export async function shootFirst(browser, web, scenario, { stand }) {
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  try {
    // ── 01. Кнопка агента в боковом меню, на любой странице ─────────────────
    await openSection(page, web, '/');
    await scenario.shot(page, '01-launcher');

    // ── 02. Окно рядом со страницей: пусто, контекст страницы ───────────────
    await openAgent(page);
    await scenario.shot(page, '02-empty');

    // ── 03. Карточка изменения: что будет сделано, фокус на «Выполнить» ─────
    await send(
      page,
      t(`Добавь проект ${join(stand, 'shop')}`, `Add project ${join(stand, 'shop')}`),
      { card: true },
    );
    await windowShot(scenario, page, '03-change-card');

    // ── 04. Выполнено: проект в реестре, страница открыта агентом ───────────
    await page.locator('[data-agent-decision="approve"]').click();
    await turnOver(page);
    await page.waitForURL(/\/projects/, { timeout: 15_000 });
    // Страницу перечитывает кадр итога (раздел действия) — без F5.
    await page
      .getByText(t('Магазин', 'Shop'), { exact: true })
      .first()
      .waitFor({ timeout: 15_000 });
    await page.waitForTimeout(1200);
    await scenario.shot(page, '04-done');

    // ── 05. Правка файла: дифф CLAUDE.md в карточке ─────────────────────────
    await send(
      page,
      t('Добавь правило: всегда отвечать по-русски', 'Add a rule: always answer in Russian'),
      { card: true },
    );
    await windowShot(scenario, page, '05-diff-card');

    // ── 06. После «Выполнить» правило в разделе «Правила» ───────────────────
    await page.locator('[data-agent-decision="approve"]').click();
    await turnOver(page);
    await page.waitForURL(/\/rules/, { timeout: 15_000 }).catch(() => undefined);
    await page.waitForTimeout(2000);
    await scenario.shot(page, '06-rule-saved');

    // ── 07. Опасное действие: фокус на «Отклонить» ──────────────────────────
    await send(page, t('Удали правило про русский язык', 'Delete the Russian-language rule'), {
      card: true,
      leaveInput: true,
    });
    // Без фокуса на «Отклонить» кадр 08 показал бы не то, о чём он.
    await page.waitForSelector('[data-agent-decision="reject"]:focus', { timeout: 5000 });
    await windowShot(scenario, page, '07-danger-card');

    // ── 08. Enter по привычке отклоняет, а не удаляет ───────────────────────
    await page.keyboard.press('Enter');
    await turnOver(page);
    await windowShot(scenario, page, '08-rejected');

    // ── 09. След действий ───────────────────────────────────────────────────
    await view(page, 'След действий', 'Action trail');
    await windowShot(scenario, page, '09-journal');

    // ── 10. История разговоров ──────────────────────────────────────────────
    await view(page, 'История', 'History');
    await windowShot(scenario, page, '10-history');
  } finally {
    await page.close();
  }
}

export async function shootGuards(browser, web, scenario, { panel, configDir }) {
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const appData = join(configDir, 'agentdeck');
  try {
    await openSection(page, web, '/platform');
    await openAgent(page);
    await newConversation(page);

    // ── 01. Черновик контура: ключ в карточке — «вводите вы» ────────────────
    await send(
      page,
      t(
        'Подключи контур отдела: http://gateway.corp.internal:8080',
        'Connect the team contour: http://gateway.corp.internal:8080',
      ),
      { card: true },
    );
    await windowShot(scenario, page, '01-contour-card');

    // ── 02. Нужен ключ: панель открывает СВОЁ поле, агент его не видит ──────
    await page.locator('[data-agent-decision="approve"]').click();
    await turnOver(page);
    await page.locator('[data-agent-anchor^="contour-key:"]').first().waitFor({ timeout: 15_000 });
    await page.waitForTimeout(1500);
    await scenario.shot(page, '02-key-field');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(1200);
    await openSection(page, web, '/platform');
    await openAgent(page);

    // ── 03. Ключ, вставленный в чат, до модели доходит меткой ───────────────
    // Выдуманный ключ длиннее шестнадцати знаков: иначе встроенный образец
    // «Секретные ключи» его не узнал бы.
    const fakeKey = ['sk', 'demo', '7f3a91c2d8e04b65a1'].join('-');
    await send(page, t(`Вот ключ: ${fakeKey}`, `Here is the key: ${fakeKey}`));
    // Сохранённый разговор — то, что ушло модели: открываем его из истории.
    await view(page, 'История', 'History');
    await page.locator('[data-agent-history] button').first().click();
    await page.waitForTimeout(1800);
    await windowShot(scenario, page, '03-key-masked');

    // ── 04. Карточка устарела: файл поменялся между показом и кликом ────────
    await newConversation(page);
    await send(
      page,
      t('Добавь правило: сначала тесты, потом код', 'Add a rule: tests first, then code'),
      { card: true },
    );
    // Пока карточка ждёт, файл правит кто-то другой — человек в редакторе.
    appendFileSync(join(configDir, 'CLAUDE.md'), '\nПравка из редактора.\n', 'utf8');
    await page.waitForTimeout(800);
    await page.locator('[data-agent-decision="approve"]').click();
    await turnOver(page);
    await windowShot(scenario, page, '04-stale');

    // ── 05. MCP-сервер: секрет пустой, его введёт человек ───────────────────
    await newConversation(page);
    await send(
      page,
      t(
        'Добавь MCP-сервер gitlab, токен введу сам',
        'Add the gitlab MCP server, I will type the token myself',
      ),
      { card: true },
    );
    await windowShot(scenario, page, '05-mcp-card');
    await page.locator('[data-agent-decision="approve"]').click();
    await turnOver(page);
    // Форма этого сервера открыта на поле пустого секрета, курсор в нём.
    await page
      .locator('[data-agent-anchor^="mcp-secret:"] input[type="password"]:focus')
      .first()
      .waitFor({ timeout: 15_000 });
    await page.waitForTimeout(1200);
    await scenario.shot(page, '06-mcp-secret');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(800);

    // ── 07. Активен другой CLI — ход не запускается ─────────────────────────
    await newConversation(page);
    await patchSettings(panel, { provider: 'codex' });
    await openSection(page, web, '/settings');
    await openAgent(page);
    await send(page, t('Что ты умеешь?', 'What can you do?'));
    await windowShot(scenario, page, '07-other-cli');
    await patchSettings(panel, { provider: 'claude' });

    // ── 08. Правила маскирования сломаны — без маски сообщение не уходит ────
    writeFileSync(join(appData, 'dlp-rules.json'), '{ не json', 'utf8');
    await openSection(page, web, '/');
    await openAgent(page);
    await newConversation(page);
    await send(page, t('Что ты умеешь?', 'What can you do?'));
    await windowShot(scenario, page, '08-dlp-broken');
    rmSync(join(appData, 'dlp-rules.json'), { force: true });

    // ── 09–12. Прочие отказы до запуска: ответ маршрута подменён (см. шапку) ─
    const refusals = [
      ['09-cli-not-found', 'cli_not_found', 'Claude Code не найден в PATH процесса панели.'],
      ['10-endpoint-unsupported', 'endpoint_unsupported', 'Ассистенту выбран свой эндпоинт.'],
      ['11-contour-unreachable', 'contour_unreachable', 'Шлюз контура не поднят.'],
      ['12-busy', 'busy', 'В этом разговоре агент ещё отвечает — дождитесь конца хода.'],
    ];
    for (const [frame, error, message] of refusals) {
      await page.route('**/api/agent/run', (route) =>
        route.fulfill({ status: 409, json: { error, message } }),
      );
      await newConversation(page);
      await send(page, t('Что ты умеешь?', 'What can you do?'));
      await windowShot(scenario, page, frame);
      await page.unroute('**/api/agent/run');
    }
  } finally {
    await patchSettings(panel, { provider: 'claude' }).catch(() => undefined);
    await page.close();
  }
}
