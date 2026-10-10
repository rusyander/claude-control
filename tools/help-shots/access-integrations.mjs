/**
 * Сценарии раздела «Интеграции»: `integrations/atlassian` и `integrations/notify`.
 *
 * Каждая система — своя карточка, и в списке только заведённые: сценарий
 * начинается с пустого списка и добавляет карточки так же, как человек, —
 * выбором «Добавить интеграцию». «Найти уже подключённые» снимается на MCP-
 * серверах, записанных в `~/.claude.json` одноразового стенда.
 *
 * Делятся по входу. В первый приходят за внешним КОНТЕКСТОМ — требования в
 * Confluence, задачи в Jira, дефекты в фордже, — и главный вопрос там «чем
 * панель представится и как я узнаю, что связь есть». Во второй приходят за
 * УВЕДОМЛЕНИЕМ: панель должна сама сказать, что прогон упал, и вопрос другой —
 * что именно уйдёт наружу.
 *
 * Проверки связи настоящие: на петле поднят выдуманный верх, отвечающий и за
 * Jira (оба диалекта), и за GitLab, и за приёмник вебхука. Диалект Atlassian в
 * кадре определён живой пробой, а не выбран в поле, — поле остаётся «не
 * выбрано» до самой проверки.
 *
 * ЕДИНСТВЕННОЕ, что закрывается в кадрах сверх общего списка, — адреса из
 * подсказок полей (`…atlassian.net`, `github.com`). Не потому, что это секрет,
 * а потому, что проверка каталога снимков краснеет на любом чужом домене:
 * так она ловит кадр, переснятый не на стенде, а на живой системе заказчика.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { openSection, openSettingsTab, card, shotCard } from './access-providers-fixture.mjs';

/** Выдуманные секреты: собираются из кусков, чтобы в файле не лежала строка вида ключа. */
const JIRA_TOKEN = ['atl', 'demo', '5c1f7b9e42a0'].join('_');
const FORGE_TOKEN = ['glpat', 'demo', '7d3c81ba60f4'].join('-');
const HOOK_SECRET = ['whsec', 'demo', 'a92e5f0c7b13'].join('_');

const JIRA = card('Jira');
const FORGE = card('GitLab');
const DISCOVERED = card('Найдено среди MCP-серверов');
const WEBHOOK = card('Вебхук');

const SITE = { enabled: false, baseUrl: '', email: '', deployment: '' };
const FORGE_SITE = { enabled: false, baseUrl: '', repo: '' };
const TMS = { enabled: false, baseUrl: '', projectKey: '', groupId: '' };
const TELEGRAM = card('Telegram');

export async function shootAtlassian(browser, web, scenario, { panel, upstream }) {
  const page = await browser.newPage({ viewport: { width: 1400, height: 1300 } });

  try {
    await resetIntegrations(panel);

    // ── 01. Пустой список ────────────────────────────────────────────────────
    // Ничего не заведено: панель остаётся местным приложением, пока её не
    // попросили ходить наружу. Карточки добавляются выбором.
    await openSettingsTab(page, web, 'integrations', 3000);
    await scenario.shot(page, '01-cards');
    await addIntegration(page, 'Jira');

    // ── 02. Заполненная карточка ─────────────────────────────────────────────
    // «Установка» остаётся «не выбрано»: её определит живая проверка и запомнит.
    await page
      .locator(JIRA)
      .getByLabel(/^(Адрес сайта|Site URL)$/)
      .first()
      .fill(upstream);
    await page
      .locator(JIRA)
      .getByLabel(/^(Почта|Email)$/)
      .first()
      .fill('qa.bot@example.test');
    await page.locator(JIRA).locator('input[type="password"]').first().fill(JIRA_TOKEN);
    await page.waitForTimeout(800);
    await shotCard(scenario, page, '02-filled', JIRA);

    await page
      .locator(JIRA)
      .getByRole('button', { name: /^(Сохранить|Save)$/ })
      .first()
      .click();
    await page.waitForTimeout(2500);

    // ── 03. Живая проверка ───────────────────────────────────────────────────
    // Панель спрашивает «кто я» — дёшево и безвредно. Ответ ложится на карточку
    // и остаётся там: тост исчезает, а причина нужна как раз при правке полей.
    await page
      .locator(JIRA)
      .getByRole('button', { name: /^(Проверить связь|Check connection)$/ })
      .first()
      .click();
    await page.waitForTimeout(4000);
    await shotCard(scenario, page, '03-checked', JIRA);

    // ── 04. Те же данные — агенту ────────────────────────────────────────────
    // Кадр снимается в разделе МСР, а не на карточке: на карточке кнопка не
    // меняет ничего видимого, а результат её нажатия — появившийся сервер в
    // чужом списке, откуда его и убирают.
    await page
      .locator(JIRA)
      .getByRole('button', { name: /^(Подключить MCP Atlassian|Connect Atlassian MCP)$/ })
      .first()
      .click();
    await page.waitForTimeout(3000);
    await openSection(page, web, '/mcp', 3000);
    await scenario.shot(page, '04-mcp');
    await openSettingsTab(page, web, 'integrations', 3000);

    // ── 05. GitLab по токену ─────────────────────────────────────────────────
    // Своя инсталляция GitLab: адрес задан, и «кто я» уходит именно туда.
    await addIntegration(page, 'GitLab');
    await page
      .locator(FORGE)
      .getByLabel(/^(Адрес установки|Installation URL)$/)
      .first()
      .fill(upstream);
    await page
      .locator(FORGE)
      .getByLabel(/^(Репозиторий|Repository)$/)
      .first()
      .fill('qa/release-tools');
    await page.locator(FORGE).locator('input[type="password"]').first().fill(FORGE_TOKEN);
    await page.waitForTimeout(600);
    await page
      .locator(FORGE)
      .getByRole('button', { name: /^(Сохранить|Save)$/ })
      .first()
      .click();
    await page.waitForTimeout(2000);
    // Карточка GitLab теперь вторая сверху, и тост «Сохранено» ложится на её
    // кнопки: щелчок ждёт, пока он уйдёт.
    await toastsGone(page);
    await page
      .locator(FORGE)
      .getByRole('button', { name: /^(Проверить связь|Check connection)$/ })
      .first()
      .click();
    await page.waitForTimeout(4000);
    await shotCard(scenario, page, '05-forge', FORGE);

    // ── 06. Забыть ключ ──────────────────────────────────────────────────────
    // Настройка остаётся, ключ уходит: это две разные вещи, и путать их нельзя.
    await page
      .locator(FORGE)
      .getByRole('button', { name: /^(Забыть ключ|Forget key)$/ })
      .first()
      .click();
    await page.waitForTimeout(2500);
    await shotCard(scenario, page, '06-forgotten', FORGE);

    // ── 07. Найти уже подключённые ───────────────────────────────────────────
    // У агента уже есть MCP-серверы: GitLab с адресом и ключом, Telegram без
    // чата. Находки показаны маской; неполная видна, но не отмечается.
    await writeMcpServers(panel, upstream);
    await openSettingsTab(page, web, 'integrations', 3000);
    await page
      .getByRole('button', { name: /^(Найти уже подключённые|Find already connected)$/ })
      .click();
    await page.waitForTimeout(2500);
    await shotCard(scenario, page, '07-discover', DISCOVERED);
  } finally {
    await page.close();
  }
}

export async function shootNotify(browser, web, scenario, { panel, upstream }) {
  const page = await browser.newPage({ viewport: { width: 1400, height: 1300 } });

  try {
    await resetIntegrations(panel);
    await openSettingsTab(page, web, 'integrations', 3000);
    await addIntegration(page, 'Вебхук');
    await addIntegration(page, 'Telegram');

    // ── 01. Приёмник и подпись ───────────────────────────────────────────────
    // Секрет подписи — не токен доступа: с ним тело подписывается заголовком,
    // без него уходит без подписи. Оба варианта рабочие.
    await page
      .locator(WEBHOOK)
      .getByLabel(/^(Адрес приёмника|Receiver URL)$/)
      .first()
      .fill(`${upstream}/hooks/qa`);
    await page.locator(WEBHOOK).locator('input[type="password"]').first().fill(HOOK_SECRET);
    await page.waitForTimeout(800);
    await shotCard(scenario, page, '01-webhook', WEBHOOK);

    await page
      .locator(WEBHOOK)
      .getByRole('button', { name: /^(Сохранить|Save)$/ })
      .first()
      .click();
    await page.waitForTimeout(2500);

    // ── 02. Проверка = настоящая отправка ────────────────────────────────────
    // «Кто я» у произвольного адреса не спросишь, поэтому приёмник получает
    // тело с событием `test` — по нему он и отличит проверку от боевого.
    await page
      .locator(WEBHOOK)
      .getByRole('button', { name: /^(Проверить связь|Check connection)$/ })
      .first()
      .click();
    await page.waitForTimeout(4000);
    await shotCard(scenario, page, '02-webhook-checked', WEBHOOK);

    // ── 03. На что подписана карточка ────────────────────────────────────────
    await page
      .locator(WEBHOOK)
      .getByText(/^(Агент просит права|Agent asks for rights)$/)
      .first()
      .click();
    await page.waitForTimeout(600);
    await page
      .locator(WEBHOOK)
      .getByRole('button', { name: /^(Сохранить|Save)$/ })
      .first()
      .click();
    await page.waitForTimeout(2500);
    await shotCard(scenario, page, '03-events', WEBHOOK);

    // ── 04. Telegram ─────────────────────────────────────────────────────────
    // Карточка заполнена, но НЕ проверена: проверка Telegram уходит к серверам
    // Telegram, а стенд справки наружу не ходит. Что она отвечает, разобрано в
    // тексте раздела.
    await page
      .locator(TELEGRAM)
      .getByLabel(/^(Чат|Chat)$/)
      .first()
      .fill('@qa_release_bot');
    await page.waitForTimeout(600);
    await shotCard(scenario, page, '04-telegram', TELEGRAM);
  } finally {
    await page.close();
  }
}

/**
 * Дождаться, пока уйдут тосты: они перекрывают кнопки карточки под собой.
 * Курсор уводится в угол — над тостом его таймер стоит на паузе.
 */
async function toastsGone(page) {
  await page.mouse.move(2, 2);
  await page
    .locator('li[role="status"]')
    .first()
    .waitFor({ state: 'detached', timeout: 15_000 })
    .catch(() => undefined);
}

/** Добавить карточку так же, как человек: выбором «Добавить интеграцию». */
async function addIntegration(page, title) {
  const titles = { Вебхук: 'Webhook' };
  await page
    .getByLabel(/^(Добавить интеграцию|Add integration)$/)
    .first()
    .selectOption({ label: process.env.GUIDE_LANG === 'en' ? (titles[title] ?? title) : title });
  await page.waitForTimeout(600);
}

/**
 * MCP-серверы человека в `~/.claude.json` стенда: GitLab с адресом верха и
 * выдуманным ключом и Telegram без чата. Файл одноразового стенда, не владельца.
 */
async function writeMcpServers(panel, upstream) {
  const location = await (await fetch(`${panel}/api/location`)).json();
  const file = location.paths.mcpConfig;
  let config = {};
  try {
    config = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    /* файла ещё нет */
  }
  config.mcpServers = {
    ...config.mcpServers,
    'gitlab-qa': {
      command: 'npx',
      args: ['-y', '@zereight/mcp-gitlab'],
      env: { GITLAB_API_URL: `${upstream}/api/v4`, GITLAB_PERSONAL_ACCESS_TOKEN: FORGE_TOKEN },
    },
    'telegram-inbox': {
      command: 'npx',
      args: ['-y', 'mcp-telegram'],
      env: { TELEGRAM_BOT_TOKEN: ['8123', 'demo', 'bot'].join(':') },
    },
  };
  writeFileSync(
    file,
    `${JSON.stringify(config, null, 2)}
`,
    'utf8',
  );
}

/** Вернуть все интеграции в состояние «ничего не подключено». */
async function resetIntegrations(panel) {
  const response = await fetch(`${panel}/api/settings`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      integrations: {
        jira: SITE,
        confluence: SITE,
        gitlab: FORGE_SITE,
        github: FORGE_SITE,
        telegram: { enabled: false, chatId: '', events: ['runError', 'testFailed'] },
        zephyr: TMS,
        xray: TMS,
        testit: TMS,
        ci: { enabled: false, kind: '', repo: '', workflow: '', artifact: '' },
        webhook: { enabled: false, url: '', events: ['runError', 'testFailed'] },
      },
    }),
  });
  if (!response.ok) throw new Error(`PATCH /api/settings integrations: ${response.status}`);
}
