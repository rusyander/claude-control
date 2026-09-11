/**
 * Прогон раздела «Интеграции» — вкладка настроек и привязка проекта.
 *
 * Проверяется то, ради чего раздел заведён: пять коннекторов открываются одной
 * вкладкой, сохранение уносит настройки И токен ОДНИМ запросом, само значение
 * токена на экран не попадает ни разу (только маска), живая проверка ходит
 * своим маршрутом и её итог виден в карточке, «Забыть» стирает ключ, события
 * Telegram уходят списком, а в разделе тестов привязку можно найти поиском и
 * прикрепить к проекту.
 *
 * Весь API подменён: настоящая проверка связи ходит в чужой Atlassian, которого
 * на машине проверяющего нет и быть не должно. Тем же приёмом живут
 * `check-project-tests.mjs`, `check-attention.mjs` и `check-project-code.mjs`.
 *
 * Запуск: `node tools/qa/check-integrations.mjs` при поднятом `pnpm dev`.
 */
import { chromium } from 'playwright';
import { bypassOnboarding } from './bypass-onboarding.mjs';

const BASE = process.env.APP_URL ?? 'http://localhost:8888';
const PROJECT = { name: 'QA проект', path: 'C:/qa-project' };

/** Настоящее значение ключа: оно не должно появиться на экране никогда. */
const SECRET = 'atl-secret-value-0000';

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });

/** Состояние «сервера»: настройки коннекторов и итоги проверок. */
let settings = {
  atlassian: {
    enabled: false,
    baseUrl: 'https://site.atlassian.net',
    email: 'qa@example.com',
    deployment: 'cloud',
    confluenceUrl: '',
  },
  forge: { enabled: false, kind: 'github', baseUrl: '', repo: 'org/app' },
  telegram: { enabled: false, chatId: '@qa', events: [] },
  tms: { enabled: false, kind: '', projectKey: '', groupId: '' },
  ci: { enabled: false, kind: '', repo: '', workflow: '', artifact: '' },
};

let statuses = [
  {
    id: 'atlassian',
    enabled: false,
    hasToken: true,
    maskedToken: 'atl…0000',
    state: 'unchecked',
    detail: '',
  },
  { id: 'forge', enabled: false, hasToken: false, maskedToken: '', state: 'unchecked', detail: '' },
  {
    id: 'telegram',
    enabled: false,
    hasToken: false,
    maskedToken: '',
    state: 'unchecked',
    detail: '',
  },
  { id: 'tms', enabled: false, hasToken: false, maskedToken: '', state: 'unchecked', detail: '' },
  { id: 'ci', enabled: false, hasToken: false, maskedToken: '', state: 'unchecked', detail: '' },
];

/** Что ушло на сервер — по этому проверяется, что кнопки делают обещанное. */
let saved;
let checked;
let forgotten;
let telegramTested = false;
let savedLink;

// Заплата настроек держится ссылкой: проверка меняет карточки по ходу, а
// `bypassOnboarding` захватывает объект один раз — переприсваивание `settings`
// до страницы бы не дошло.
const settingsPatch = { integrations: settings };
await bypassOnboarding(page, settingsPatch);

const problems = [];
page.on('pageerror', (error) => problems.push(error.message));
page.on('console', (message) => message.type() === 'error' && problems.push(message.text()));

const statusOf = (id) => statuses.find((item) => item.id === id);

// Общее раньше частного: Playwright отдаёт запрос ПОСЛЕДНЕМУ подходящему
// обработчику, а `/integrations/links` подходит и к `/integrations/*`.
await page.route('**/api/integrations', async (route) => route.fulfill({ json: statuses }));

await page.route('**/api/integrations/*', async (route) => {
  const request = route.request();
  const id = new URL(request.url()).pathname.split('/').pop();

  if (request.method() === 'DELETE') {
    forgotten = id;
    statuses = statuses.map((item) =>
      item.id === id ? { ...item, hasToken: false, maskedToken: '', enabled: false } : item,
    );
    return route.fulfill({ json: statusOf(id) });
  }

  if (request.method() === 'PUT') {
    saved = { id, ...request.postDataJSON() };
    settings = { ...settings, [id]: { ...settings[id], ...saved.settings } };
    statuses = statuses.map((item) =>
      item.id === id
        ? {
            ...item,
            enabled: Boolean(saved.settings.enabled),
            hasToken: item.hasToken || Boolean(saved.token),
            maskedToken: saved.token ? 'atl…0000' : item.maskedToken,
          }
        : item,
    );
    return route.fulfill({ json: statusOf(id) });
  }

  return route.fulfill({ json: statusOf(id) });
});

await page.route('**/api/integrations/*/check', async (route) => {
  const id = new URL(route.request().url()).pathname.split('/').at(-2);
  checked = id;
  statuses = statuses.map((item) =>
    item.id === id
      ? {
          ...item,
          state: 'ok',
          detail: 'связь есть',
          account: 'QA Робот',
          deployment: 'cloud',
          checkedAt: '2026-09-07T10:00:00.000Z',
        }
      : item,
  );
  return route.fulfill({ json: statusOf(id) });
});

await page.route('**/api/integrations/telegram/test', async (route) => {
  telegramTested = true;
  return route.fulfill({ json: { ok: true } });
});

await page.route('**/api/integrations/mcp/connect', async (route) =>
  route.fulfill({ json: { name: 'atlassian' } }),
);

await page.route('**/api/integrations/jira/projects*', async (route) =>
  route.fulfill({ json: [{ id: '1', key: 'QA', name: 'Качество' }] }),
);

await page.route('**/api/integrations/jira/search*', async (route) =>
  route.fulfill({
    json: [
      {
        key: 'QA-42',
        summary: 'Оплата картой не проходит',
        status: 'В работе',
        type: 'Bug',
        url: 'https://site.atlassian.net/browse/QA-42',
      },
    ],
  }),
);

await page.route('**/api/integrations/confluence/search*', async (route) =>
  route.fulfill({
    json: [
      {
        id: '77',
        title: 'Требования к оплате',
        spaceKey: 'QA',
        url: 'https://site.atlassian.net/wiki/x/77',
      },
    ],
  }),
);

let links = { project: {}, groups: {} };
await page.route('**/api/integrations/links*', async (route) => {
  const request = route.request();
  if (request.method() === 'PUT') {
    savedLink = request.postDataJSON();
    const link = savedLink.link;
    links = savedLink.groupId
      ? { ...links, groups: { ...links.groups, [savedLink.groupId]: link } }
      : { ...links, project: link };
  }
  if (request.method() === 'DELETE') links = { project: {}, groups: {} };
  return route.fulfill({ json: links });
});

// Разделы, которые страница дёргает попутно: молчащий маршрут дал бы 404 в
// консоль вместо проверки.
await page.route('**/api/mcp', async (route) => route.fulfill({ json: [] }));
await page.route('**/api/project-git*', async (route) =>
  route.fulfill({
    json: { isRepo: false, detached: false, unborn: false, branches: [], changes: [] },
  }),
);
await page.route('**/api/chats/projects*', async (route) =>
  route.fulfill({
    json: [
      {
        path: PROJECT.path,
        name: PROJECT.name,
        exists: true,
        lastActivity: '2026-09-01T10:00:00.000Z',
        chats: [],
      },
    ],
  }),
);
await page.route('**/api/project-tests/runs*', async (route) =>
  route.fulfill({ json: { runs: [] } }),
);
await page.route('**/api/project-tests/plans*', async (route) =>
  route.fulfill({ json: { plans: [] } }),
);
await page.route('**/api/project-tests/manual*', async (route) => route.fulfill({ json: {} }));
// Разбор, риск, карантин и веха спрашиваются самим разделом при открытии. Проект
// здесь выдуман, поэтому без подмены это 400 в консоли — то есть красная проверка
// «ошибок нет» про чужую страницу, а не про интеграции.
await page.route('**/api/project-tests/lint*', async (route) =>
  route.fulfill({
    json: {
      findings: [],
      byRule: [],
      duplicates: [],
      checked: 0,
      checkedAt: '2026-09-08T10:00:00.000Z',
    },
  }),
);
await page.route('**/api/project-tests/risk*', async (route) =>
  route.fulfill({ json: { items: [], checkedAt: '2026-09-08T10:00:00.000Z' } }),
);
await page.route('**/api/project-tests/quarantine*', async (route) =>
  route.fulfill({
    json: {
      lift: [],
      quarantine: [],
      stale: [],
      thresholds: { greenStreak: 5, stability: 70, minRuns: 4 },
      checkedAt: '2026-09-08T10:00:00.000Z',
    },
  }),
);
await page.route('**/api/project-tests/release*', async (route) =>
  route.fulfill({ json: { releases: [] } }),
);
await page.route('**/api/project-tests/impact*', async (route) =>
  route.fulfill({ json: { files: [], cases: [] } }),
);
await page.route('**/api/project-tests?*', async (route) =>
  route.fulfill({
    json: {
      projectPath: PROJECT.path,
      dir: '.agent/tests',
      hasConvention: true,
      sharedSteps: [],
      environments: [],
      schema: { attributes: [], statuses: [] },
      views: [],
      plans: [],
      groups: [{ id: 'gui', title: 'GUI', file: '.agent/tests/gui.tests.json', cases: [] }],
    },
  }),
);

let bad = 0;
const check = (ok, text) => {
  console.log(`${ok ? 'ок  ' : 'ПЛОХО'} ${text}`);
  if (!ok) bad += 1;
};

const main = page.getByRole('main').or(page.locator('body')).first();

// ── Вкладка настроек ────────────────────────────────────────────────────────
await page.goto(`${BASE}/settings?tab=integrations`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('nav');
await page.waitForTimeout(1500);

const opened = (await main.getByRole('tab', { name: /Интеграции/ }).count()) > 0;
check(opened, 'в настройках есть вкладка «Интеграции»');
if (!opened) {
  console.log('\nВкладка не открылась — остальные проверки не выполнялись.');
  await browser.close();
  process.exit(1);
}

for (const name of [/Atlassian/, /Фордж|Forge/, /Telegram/, /Тест-менеджмент/, /^CI$|CI\b/]) {
  check((await main.getByText(name).count()) > 0, `карточка коннектора на экране: ${name}`);
}

// Маска вместо ключа. Проверяем ВЕСЬ текст страницы: секрет не должен
// оказаться ни в подписи, ни в подсказке, ни в значении поля.
const pageText = await page.evaluate(() => document.body.innerText);
const inputs = await page
  .locator('input')
  .evaluateAll((nodes) => nodes.map((node) => node.value ?? '').join(' | '));
check(!pageText.includes(SECRET) && !inputs.includes(SECRET), 'сырой токен на экране не появился');
check(pageText.includes('atl…0000'), 'сохранённый ключ показан маской');

// Сохранение: настройки и токен уходят одним запросом.
const tokenField = main.getByLabel(/Токен/).first();
check((await tokenField.count()) > 0, 'у карточки есть поле токена');
await tokenField.fill(SECRET);
const urlField = main.getByLabel(/Адрес сайта|Адрес Jira/).first();
if ((await urlField.count()) > 0) await urlField.fill('https://qa.atlassian.net');
await main
  .getByRole('button', { name: /Сохранить/ })
  .first()
  .click();
await page.waitForTimeout(1200);

check(saved?.id === 'atlassian', `сохранение адресовано коннектору: ${saved?.id}`);
check(saved?.token === SECRET, 'токен ушёл на сервер один раз, вместе с настройками');
check(
  saved?.settings?.baseUrl === 'https://qa.atlassian.net',
  `правка адреса уехала: ${saved?.settings?.baseUrl}`,
);
const afterSave = await page
  .locator('input')
  .evaluateAll((nodes) => nodes.map((node) => node.value ?? '').join(' | '));
check(!afterSave.includes(SECRET), 'после сохранения поле токена очищено');

// Живая проверка: свой маршрут, итог в карточке.
await main
  .getByRole('button', { name: /Проверить связь/ })
  .first()
  .click();
await page.waitForTimeout(1200);
check(checked === 'atlassian', `«Проверить связь» ушла своим маршрутом: ${checked}`);
check((await main.getByText('связь есть').count()) > 0, 'итог проверки виден в карточке');
check((await main.getByText(/QA Робот/).count()) > 0, 'видно, кем панель представилась');

// События Telegram: список уходит вместе с настройками.
const eventBox = main.getByText(/Прогон завершён/).first();
if ((await eventBox.count()) > 0) {
  await eventBox.click();
  await page.waitForTimeout(400);
  const telegramCard = main.getByText('Telegram').first();
  check((await telegramCard.count()) > 0, 'карточка Telegram на месте');
  const saveButtons = main.getByRole('button', { name: /Сохранить/ });
  await saveButtons.nth(2).click();
  await page.waitForTimeout(1000);
  check(
    Array.isArray(saved?.settings?.events) && saved.settings.events.includes('runDone'),
    `выбранное событие уехало списком: ${JSON.stringify(saved?.settings?.events)}`,
  );
} else {
  check(false, 'у Telegram есть список событий');
}

// Пробное сообщение — отдельным маршрутом: «дозвонились» и «дошло» не одно и то же.
const testButton = main.getByRole('button', { name: /Отправить пробное/ }).first();
if ((await testButton.count()) > 0) {
  await testButton.click();
  await page.waitForTimeout(900);
  check(telegramTested, 'пробное сообщение Telegram ушло своим маршрутом');
} else {
  check(false, 'есть кнопка пробного сообщения Telegram');
}

// Забыть ключ.
const forgetButton = main.getByRole('button', { name: /Забыть/ }).first();
if ((await forgetButton.count()) > 0) {
  await forgetButton.click();
  await page.waitForTimeout(1000);
  check(forgotten === 'atlassian', `«Забыть» ушло на сервер: ${forgotten}`);
} else {
  check(false, 'есть кнопка «Забыть токен» у коннектора с ключом');
}

// ── Включённая карточка без обязательного поля (находка M7 ревью Т9) ────────
// Test IT без адреса раньше сохранялся ВКЛЮЧЁННЫМ: правило «чего не хватает»
// гасило тумблер, но не кнопку сохранения — карточка горела зелёным, а первая
// же операция отвечала «не указан адрес Test IT».
settings = {
  ...settings,
  tms: { enabled: true, kind: 'testit', baseUrl: '', projectKey: 'PRJ-1', groupId: '' },
};
settingsPatch.integrations = settings;
statuses = statuses.map((card) =>
  card.id === 'tms' ? { ...card, enabled: true, state: 'ok' } : card,
);
saved = undefined;
await page.goto(`${BASE}/settings?tab=integrations`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1200);

const tmsCard = page
  .locator('div[class*="padding-md"]')
  .filter({ hasText: 'Тест-менеджмент' })
  .last();
check((await tmsCard.count()) > 0, 'карточка тест-менеджмента на месте');
if ((await tmsCard.count()) > 0) {
  const projectField = tmsCard.getByLabel(/Проект/).first();
  await projectField.fill('PRJ-2');
  await page.waitForTimeout(300);
  const tmsSave = tmsCard.getByRole('button', { name: /Сохранить/ }).first();
  check(
    await tmsSave.isDisabled(),
    'правку включённой карточки нельзя сохранить, пока пуст обязательный адрес',
  );

  await tmsCard.getByLabel(/Адрес/).first().fill('https://testit.acme.local');
  await page.waitForTimeout(300);
  check(await tmsSave.isEnabled(), 'адрес заполнен — сохранение снова доступно');
  await tmsSave.click();
  await page.waitForTimeout(1000);
  check(
    saved?.id === 'tms' && saved?.settings?.baseUrl === 'https://testit.acme.local',
    `настройка уехала с адресом: ${saved?.settings?.baseUrl}`,
  );
}

// ── Привязка проекта в разделе тестов ───────────────────────────────────────
await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
await page.evaluate(
  (project) =>
    localStorage.setItem(
      'agentdeck:workspace',
      JSON.stringify({
        projectTabs: [{ id: project.path.toLowerCase(), path: project.path, name: project.name }],
        activeTabId: project.path.toLowerCase(),
        views: {},
      }),
    ),
  PROJECT,
);
await page.goto(`${BASE}/tests`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('nav');
await page.waitForTimeout(1800);

const attach = main.getByRole('button', { name: /Привязать/ }).first();
check((await attach.count()) > 0, 'в разделе тестов есть кнопка привязки');
if ((await attach.count()) > 0) {
  await attach.click();
  await page.waitForTimeout(800);
  const dialog = page.getByRole('dialog').first();
  check((await dialog.count()) > 0, 'окно привязки открылось');

  const search = dialog.getByLabel(/Поиск задач/).first();
  if ((await search.count()) > 0) {
    await search.fill('оплата');
    await dialog.getByRole('button', { name: /Найти/ }).first().click();
    await page.waitForTimeout(1000);
    check((await dialog.getByText(/QA-42/).count()) > 0, 'поиск по Jira вернул задачу');
    await dialog.getByText(/QA-42/).first().click();
    await page.waitForTimeout(400);
    await dialog
      .getByRole('button', { name: /Сохранить/ })
      .first()
      .click();
    await page.waitForTimeout(1200);
    check(
      savedLink?.link?.jiraIssueKey === 'QA-42',
      `привязка ушла ключом: ${savedLink?.link?.jiraIssueKey}`,
    );
    check(
      savedLink?.link?.jiraIssueTitle?.includes('Оплата'),
      'вместе с ключом сохранён заголовок — строка читается без похода в Jira',
    );
    check((await main.getByText(/QA-42/).count()) > 0, 'привязка видна в разделе после сохранения');
  } else {
    check(false, 'в окне привязки есть поиск по Jira');
  }
}

check(problems.length === 0, `ошибок в консоли нет: ${problems.slice(0, 3).join(' | ')}`);

await browser.close();
console.log(bad === 0 ? '\nИнтеграции в порядке.' : `\nПроблем: ${bad}`);
process.exit(bad === 0 ? 0 : 1);
