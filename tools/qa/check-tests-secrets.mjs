/**
 * Доступы стенда: пароль вводится, но обратно не показывается.
 *
 * Проверяется ровно то, ради чего доступы и заводили, и то, чем они опасны:
 * ввод уходит на сервер, наружу возвращается маска, введённого значения на
 * странице после сохранения нет, а имя переменной панели получает отказ с
 * причиной.
 *
 * Ответы сервера подменяются целиком: настоящее хранилище зашифровано и лежит в
 * каталоге панели, и трогать его сквозняком нельзя.
 *
 * Запуск: `node tools/qa/check-tests-secrets.mjs` при поднятом `pnpm dev`.
 */
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { bypassOnboarding } from './bypass-onboarding.mjs';

const BASE = process.env.APP_URL ?? 'http://localhost:8888';
const PROJECT = { name: 'QA проект', path: 'C:/qa-project' };
const SECRET = 'очень-секретно-42';

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
await bypassOnboarding(page);

const problems = [];
page.on('pageerror', (error) => problems.push(error.message));
page.on('console', (message) => {
  if (message.type() !== 'error') return;
  // Отказ по занятому имени — часть проверки: браузер печатает 400 сам.
  if ((message.location()?.url ?? '').includes('/env-secret')) return;
  problems.push(message.text());
});

const environment = {
  id: 'stand',
  title: 'Стенд',
  baseUrl: 'https://stand.example',
  isDefault: true,
  secrets: [
    { name: 'STAND_LOGIN', title: 'Логин тестового пользователя' },
    { name: 'STAND_PASSWORD', title: 'Пароль тестового входа' },
  ],
};

const view = {
  projectPath: PROJECT.path,
  dir: '.agent/tests',
  hasConvention: true,
  sharedSteps: [],
  environments: [environment],
  schema: { attributes: [], statuses: [] },
  views: [],
  plans: [],
  drafts: [],
  branch: 'main',
  groups: [
    {
      id: 'gui',
      title: 'GUI',
      file: '.agent/tests/gui.tests.json',
      cases: [
        {
          id: 'gui-001',
          type: 'case',
          title: 'Вход существующим пользователем',
          steps: [],
          status: 'unknown',
          source: 'agent',
        },
      ],
    },
  ],
};

/** Состояние подменённого хранилища: что задано на «этой машине». */
const stored = { STAND_LOGIN: 'qa-user' };
/** Что панель отправляла: по этому видно, что ушло значение, а не подпись. */
const sent = [];

/** Маска сервера: длина точками и два последних символа — не больше. */
const mask = (value) =>
  value ? `${'•'.repeat(Math.min(value.length - 2, 12))}${value.slice(-2)}` : '';

const secretsBody = () => ({
  environmentId: environment.id,
  secrets: environment.secrets.map((ref) => ({
    ...ref,
    hasValue: Boolean(stored[ref.name]),
    masked: mask(stored[ref.name]),
  })),
});

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
        lastActivity: '2026-09-08T10:00:00.000Z',
        chats: [],
      },
    ],
  }),
);

await page.route('**/api/project-tests/env-secret*', async (route) => {
  const request = route.request();
  const method = request.method();
  if (method === 'GET') return route.fulfill({ json: secretsBody() });

  if (method === 'POST') {
    const body = request.postDataJSON() ?? {};
    sent.push(body);
    // Имена самой панели сервер не отдаёт — сквозняк проверяет, что отказ виден.
    if (String(body.name ?? '').startsWith('ANTHROPIC_')) {
      return route.fulfill({
        status: 400,
        json: { message: 'Переменная «ANTHROPIC_API_KEY» занята самой панелью.' },
      });
    }
    if (typeof body.value === 'string' && body.value) stored[body.name] = body.value;
    if (!environment.secrets.some((item) => item.name === body.name)) {
      environment.secrets.push({ name: body.name, title: body.title });
    }
    return route.fulfill({ json: { ...secretsBody(), view } });
  }

  const url = new URL(request.url());
  const name = url.searchParams.get('name') ?? '';
  sent.push({ deleted: name });
  delete stored[name];
  environment.secrets = environment.secrets.filter((item) => item.name !== name);
  return route.fulfill({ json: { ...secretsBody(), view } });
});

await page.route('**/api/project-tests/runs*', async (route) =>
  route.fulfill({ json: { runs: [] } }),
);
await page.route('**/api/project-tests/report*', async (route) =>
  route.fulfill({
    json: {
      runs: [],
      areas: [],
      automation: { manual: 1, toAutomate: 0, automated: 0 },
      flaky: [],
      failures: [],
      evidence: { failed: 0, proven: 0, detailed: 0, missing: [], flaky: [] },
      releases: [],
      totals: { runs: 0, tokens: 0, costUsd: 0, durationMs: 0, muted: 0 },
    },
  }),
);
await page.route('**/api/project-tests/release*', async (route) =>
  route.fulfill({ json: { releases: [] } }),
);
await page.route('**/api/project-tests/coverage*', async (route) =>
  route.fulfill({ json: { items: [], orphans: [], source: 'links', jql: '' } }),
);
await page.route('**/api/project-tests/lint*', async (route) =>
  route.fulfill({
    json: {
      findings: [],
      byRule: [],
      duplicates: [],
      checked: 1,
      checkedAt: '2026-09-08T10:00:00.000Z',
    },
  }),
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
await page.route('**/api/project-tests/risk*', async (route) =>
  route.fulfill({ json: { items: [], checkedAt: '2026-09-08T10:00:00.000Z' } }),
);
await page.route('**/api/project-tests/plans*', async (route) =>
  route.fulfill({ json: { plans: [] } }),
);
await page.route('**/api/project-tests/manual*', async (route) => route.fulfill({ json: {} }));
await page.route('**/api/project-tests/impact*', async (route) =>
  route.fulfill({ json: { files: [], cases: [] } }),
);
await page.route('**/api/project-tests?*', async (route) => route.fulfill({ json: view }));

let bad = 0;
const check = (ok, text) => {
  console.log(`${ok ? 'ок  ' : 'ПЛОХО'} ${text}`);
  if (!ok) bad += 1;
};

/** Снимки: `SHOTS=<каталог> node tools/qa/check-tests-secrets.mjs`. */
const shotsDir = process.env.SHOTS;
const shot = async (name) => {
  if (!shotsDir) return;
  await mkdir(shotsDir, { recursive: true });
  await page.screenshot({ path: join(shotsDir, `${name}.png`), fullPage: true });
};

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
await page.waitForTimeout(2000);

const main = page.getByRole('main').or(page.locator('body')).first();
const opened = (await main.getByText('.agent/tests', { exact: false }).count()) > 0;
check(opened, 'раздел «Тесты» открылся');
if (!opened) {
  console.log('\nСтраница раздела не открылась — доступы проверять не на чем.');
  await browser.close();
  process.exit(1);
}

const openButton = main.getByRole('button', { name: /^Доступы$/ }).first();
check((await openButton.count()) > 0, 'кнопка доступов стоит у выбора окружения');
await openButton.click();
await page.waitForTimeout(1200);

const dialog = page.getByRole('dialog').first();
check(
  (await dialog.getByText(/Доступы окружения «Стенд»/).count()) > 0,
  'окно открылось на выбранном окружении',
);
check(
  (await dialog.getByText('STAND_LOGIN').count()) > 0,
  'объявленная переменная названа поимённо',
);
check(
  (await dialog.getByText(/не задан на этой машине/).count()) > 0,
  'незаполненный доступ виден как «не задан», а не пропущен',
);
const masked = await dialog
  .getByText(/^задан: /)
  .first()
  .innerText();
check(
  masked.includes('•') && !masked.includes('qa-us'),
  `заполненный доступ показан маской: ${masked}`,
);
await shot('secrets-modal');

// Ввод значения: уходит на сервер и НЕ возвращается на экран.
await dialog
  .getByRole('button', { name: /^Задать$/ })
  .first()
  .click();
await dialog
  .getByLabel(/^Значение$/)
  .first()
  .fill(SECRET);
await dialog
  .getByRole('button', { name: /^Сохранить$/ })
  .first()
  .click();
await page.waitForTimeout(1200);

const saved = sent.find((item) => item.name === 'STAND_PASSWORD');
check(saved?.value === SECRET, 'значение ушло на сервер тем, что ввели');
check(saved?.environmentId === 'stand', 'доступ адресован выбранному окружению');
check((await dialog.getByText(/задан:/).count()) >= 2, 'после сохранения доступ помечен заданным');

const shown = await page.evaluate(() => document.body.innerText);
check(!shown.includes(SECRET), 'введённого значения на странице нет — только маска');

// Занятое имя: отказ виден человеку, а не проглочен.
const nameField = dialog.getByLabel(/^Переменная$/).first();
await nameField.fill('ANTHROPIC_API_KEY');
await dialog
  .getByRole('button', { name: /^Сохранить$/ })
  .last()
  .click();
await page.waitForTimeout(1200);
check(
  (await dialog.getByText(/занята самой панелью/).count()) > 0,
  'отказ по имени панели показан причиной',
);
await shot('secrets-refused');

// Забыть доступ: уходит DELETE именно по этому имени.
await nameField.fill('');
await dialog
  .getByRole('button', { name: /^Забыть$/ })
  .first()
  .click();
await page.waitForTimeout(1200);
check(
  sent.some((item) => item.deleted === 'STAND_LOGIN'),
  `удаление ушло по имени переменной: ${JSON.stringify(sent.at(-1))}`,
);
check((await dialog.getByText('STAND_LOGIN').count()) === 0, 'забытый доступ исчез из списка');

check(problems.length === 0, `ошибок в консоли нет: ${problems.slice(0, 3).join(' | ')}`);

console.log(bad === 0 ? '\nДоступы стенда в порядке.' : `\nПроблем: ${bad}`);
await browser.close();
process.exit(bad === 0 ? 0 : 1);
