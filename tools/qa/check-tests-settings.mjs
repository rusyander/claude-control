/**
 * Настройки набора: окружения, общие шаги, свои поля.
 *
 * Проверяется то, ради чего окно и заведено: три файла, которые панель ЧИТАЛА и
 * всюду использовала, теперь можно завести с экрана — и то, что она при этом не
 * делает молча. Удаление окружения, на которое ссылается план, называет план;
 * удаление общего шага говорит, сколько кейсов его потеряет; сломанный файл
 * показывает причину, а не пустой список.
 *
 * Ответы сервера подменены целиком: проверяемый проект существует только в этом
 * сквозняке — ни истории, ни установленного CLI не нужно.
 *
 * Запуск: `node tools/qa/check-tests-settings.mjs` при поднятом `pnpm dev`.
 * Снимки: `SHOTS=<каталог> node tools/qa/check-tests-settings.mjs`.
 */
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { bypassOnboarding } from './bypass-onboarding.mjs';

const BASE = process.env.APP_URL ?? 'http://localhost:8888';
const PROJECT = { name: 'QA проект', path: 'C:/qa-project' };

/** Набор с одним окружением, одним общим шагом и планом, который на него ссылается. */
let view = {
  projectPath: PROJECT.path,
  dir: '.agent/tests',
  hasConvention: true,
  sharedSteps: [
    {
      id: 'login',
      title: 'Войти под тестовым пользователем',
      steps: [{ action: 'Открыть форму входа' }, { action: 'Ввести логин и пароль' }],
    },
  ],
  environments: [
    { id: 'stand', title: 'Тестовый стенд', baseUrl: 'https://stand.local', isDefault: true },
  ],
  schema: { attributes: [], statuses: [] },
  views: [],
  plans: [{ id: 'smoke', title: 'Дым', environmentIds: ['stand'] }],
  drafts: [],
  branch: 'main',
  groups: [
    {
      id: 'gui',
      title: 'Интерфейс',
      file: '.agent/tests/gui.tests.json',
      cases: [
        {
          id: 'gui-001',
          title: 'Вход по паролю',
          type: 'case',
          source: 'human',
          status: 'passed',
          steps: [{ action: 'Войти', ref: 'login' }],
        },
      ],
    },
  ],
};

/** Что ушло на сервер — по этому и видно, что окно действительно записало. */
let savedEnvironment;
let savedStep;
let savedSchema;
let removeQuery;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
await bypassOnboarding(page);

const problems = [];
page.on('pageerror', (error) => problems.push(error.message));
page.on('console', (message) => {
  if (message.type() !== 'error') return;
  // Адрес рядом с текстом: «resource failed» без него не говорит, что именно упало.
  const url = message.location()?.url ?? '';
  problems.push(url ? `${message.text()} ← ${url}` : message.text());
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

await page.route('**/api/project-tests/environment*', async (route) => {
  const request = route.request();
  if (request.method() === 'DELETE') {
    removeQuery = new URL(request.url()).search;
    view = { ...view, environments: [] };
    return route.fulfill({ json: view });
  }
  savedEnvironment = request.postDataJSON()?.environment;
  const rest = view.environments.filter((item) => item.id !== savedEnvironment.id);
  view = {
    ...view,
    environments: [
      ...(savedEnvironment.isDefault ? rest.map((item) => ({ ...item, isDefault: false })) : rest),
      { ...savedEnvironment, id: savedEnvironment.id || 'prod' },
    ],
  };
  return route.fulfill({ json: view });
});

await page.route('**/api/project-tests/shared-step*', async (route) => {
  savedStep = route.request().postDataJSON()?.step;
  view = {
    ...view,
    sharedSteps: [...view.sharedSteps, { ...savedStep, id: savedStep.id || 'logout' }],
  };
  return route.fulfill({ json: view });
});

await page.route('**/api/project-tests/schema*', async (route) => {
  savedSchema = route.request().postDataJSON()?.schema;
  view = { ...view, schema: savedSchema };
  return route.fulfill({ json: view });
});

await page.route('**/api/project-tests/env-secrets*', async (route) =>
  route.fulfill({ json: { secrets: [] } }),
);
await page.route('**/api/project-tests/runs*', async (route) =>
  route.fulfill({ json: { runs: [] } }),
);
// Шапка страницы спрашивает ручную сессию, чтобы назвать кнопку «Ручной проход»
// или «Вернуться к проходу»; без заглушки настоящий сервер отвечает 400.
await page.route('**/api/project-tests/manual*', async (route) => route.fulfill({ json: {} }));
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
  route.fulfill({ json: { plans: view.plans } }),
);
await page.route('**/api/project-tests/impact*', async (route) =>
  route.fulfill({ json: { files: [], cases: [] } }),
);
await page.route('**/api/project-tests?*', async (route) => route.fulfill({ json: view }));

let bad = 0;
const check = (ok, text) => {
  console.log(`${ok ? 'ок  ' : 'ПЛОХО'} ${text}`);
  if (!ok) bad += 1;
};

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

const openButton = page.getByRole('button', { name: 'Настройки набора' }).first();
check((await openButton.count()) > 0, 'кнопка «Настройки набора» стоит рядом с выбором проекта');
await openButton.click();
await page.waitForTimeout(800);

const modal = page.getByRole('dialog').first();
check((await modal.count()) > 0, 'окно настроек открылось');
for (const tab of ['Окружения', 'Общие шаги', 'Свои поля']) {
  check((await modal.getByText(tab, { exact: true }).count()) > 0, `раздел «${tab}» на месте`);
}
check((await modal.getByText('Тестовый стенд').count()) > 0, 'окружение проекта показано в списке');
await shot('settings-environments');

// Окружение заводится отсюда — то, чего до этого окна нельзя было сделать вовсе.
await modal.getByLabel('Название').first().fill('Прод');
await modal.getByLabel('Адрес').first().fill('https://prod.local');
await modal.getByRole('button', { name: 'Добавить' }).first().click();
await page.waitForTimeout(800);
check(
  savedEnvironment?.title === 'Прод',
  `новое окружение ушло на сервер: ${savedEnvironment?.title}`,
);
check(savedEnvironment?.baseUrl === 'https://prod.local', 'адрес окружения записан');

// Удаление окружения, на которое ссылается план, называет план по имени.
await modal.getByRole('button', { name: 'Убрать' }).first().click();
await page.waitForTimeout(400);
check(
  (await modal.getByText(/ссылаются планы: Дым/).count()) > 0,
  'перед удалением названы планы, которые останутся без окружения',
);
await shot('settings-remove-warning');
await modal.getByRole('button', { name: 'Убрать' }).nth(1).click();
await page.waitForTimeout(800);
check(
  removeQuery?.includes('force=1'),
  `настоянное удаление ушло с force: ${removeQuery ?? 'запроса не было'}`,
);

// Общие шаги: счёт использования и заведение нового.
await modal.getByText('Общие шаги', { exact: true }).click();
await page.waitForTimeout(400);
check(
  (await modal.getByText(/в 1 кейсе/).count()) > 0,
  'у общего шага показано, в скольких кейсах он используется',
);
await modal.getByLabel('Название').first().fill('Выйти из аккаунта');
await modal.getByLabel('Шаги').first().fill('Нажать «Выйти»\nУбедиться, что открылась форма входа');
await modal.getByRole('button', { name: 'Добавить' }).first().click();
await page.waitForTimeout(800);
check(
  savedStep?.title === 'Выйти из аккаунта',
  `новый общий шаг ушёл на сервер: ${savedStep?.title}`,
);
check(savedStep?.steps?.length === 2, `шаги разобраны построчно: ${savedStep?.steps?.length}`);
await shot('settings-steps');

// Своё поле: проверка ключа до отправки и появление колонки в таблице.
await modal.getByText('Свои поля', { exact: true }).click();
await page.waitForTimeout(400);
await modal.getByLabel('Название').first().fill('Стенд');
await modal.getByLabel('Ключ').first().fill('Своё поле');
await page.waitForTimeout(300);
check(
  (await modal.getByText(/Ключ — латиница/).count()) > 0,
  'негодный ключ назван до отправки, а не после',
);
const addField = modal.getByRole('button', { name: 'Добавить' }).first();
check(await addField.isDisabled(), 'с негодным ключом кнопка не нажимается');
await modal.getByLabel('Ключ').first().fill('stand');
await page.waitForTimeout(300);
await addField.click();
await page.waitForTimeout(800);
check(
  savedSchema?.attributes?.[0]?.key === 'stand',
  `своё поле ушло на сервер: ${savedSchema?.attributes?.[0]?.key}`,
);
check(savedSchema?.attributes?.[0]?.title === 'Стенд', 'у поля записано человеческое название');
await shot('settings-fields');

// Колонка появляется в таблице сразу — это и есть смысл «своего поля».
await page.keyboard.press('Escape');
await page.waitForTimeout(800);
check(
  (await page.getByRole('columnheader', { name: 'Стенд' }).count()) > 0,
  'своё поле стало колонкой в списке кейсов сразу после сохранения',
);

// Сломанный файл: причина на экране вместо пустого списка. Пустой список тут
// значил бы «ничего не заведено», и человек переписал бы чужой файл поверх.
view = {
  ...view,
  environments: [],
  libraryIssues: [
    {
      file: '.agent/tests/environments.json',
      error: 'Файл не разобрался: Unexpected token в позиции 2.',
    },
  ],
};
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForSelector('nav');
await page.waitForTimeout(2000);
await page.getByRole('button', { name: 'Настройки набора' }).first().click();
await page.waitForTimeout(800);

const broken = page.getByRole('dialog').first();
check(
  (await broken.getByText('.agent/tests/environments.json', { exact: false }).count()) > 0,
  'сломанный файл назван по имени, а не спрятан за пустым списком',
);
check(
  (await broken.getByText(/панель в него не пишет/).count()) > 0,
  'сказано, что панель в сломанный файл не пишет',
);
await shot('settings-broken');

check(problems.length === 0, `ошибок в консоли нет${problems.length ? `: ${problems[0]}` : ''}`);

console.log(bad === 0 ? '\nНастройки набора: всё на месте.' : `\nПроблем: ${bad}`);
await browser.close();
process.exit(bad === 0 ? 0 : 1);
