/**
 * Пустой проект: три шага вместо пустого списка.
 *
 * Проверяется то, ради чего шаги и заведены: человек, открывший раздел на
 * проекте без единого кейса, видит, ЧТО делать первым, и может сделать это
 * отсюда — завести окружение и запустить генерацию. Отдельно проверяется, что
 * заведённое окружение перестаёт быть шагом: висящий «шаг 1» на сделанном
 * означает, что панель не видит состояния проекта.
 *
 * Ответы сервера подменены целиком: проверяемый проект существует только в
 * этом сквозняке.
 *
 * Запуск: `node tools/qa/check-tests-onboarding.mjs` при поднятом `pnpm dev`.
 */
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { bypassOnboarding } from './bypass-onboarding.mjs';

const BASE = process.env.APP_URL ?? 'http://localhost:8888';
const PROJECT = { name: 'QA проект', path: 'C:/qa-project' };

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
await bypassOnboarding(page);

const problems = [];
page.on('pageerror', (error) => problems.push(error.message));
page.on('console', (message) => message.type() === 'error' && problems.push(message.text()));

/** Пустой проект: ни групп, ни окружений — то, с чего начинается любой набор. */
let view = {
  projectPath: PROJECT.path,
  dir: '.agent/tests',
  hasConvention: false,
  sharedSteps: [],
  environments: [],
  schema: { attributes: [], statuses: [] },
  views: [],
  plans: [],
  drafts: [],
  branch: 'main',
  groups: [],
};

/** Что ушло на сервер: по этому и видно, что шаг действительно сработал. */
let savedEnvironment;
let startBody;

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
  savedEnvironment = route.request().postDataJSON()?.environment;
  view = { ...view, environments: [savedEnvironment] };
  return route.fulfill({ json: view });
});

await page.route('**/api/project-tests/run*', async (route) => {
  startBody = route.request().postDataJSON();
  return route.fulfill({ json: view });
});

await page.route('**/api/project-tests/runs*', async (route) =>
  route.fulfill({ json: { runs: [] } }),
);
await page.route('**/api/project-tests/report*', async (route) =>
  route.fulfill({
    json: {
      runs: [],
      areas: [],
      automation: { manual: 0, toAutomate: 0, automated: 0 },
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
      checked: 0,
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

/** Снимки: `SHOTS=<каталог> node tools/qa/check-tests-onboarding.mjs`. */
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
  console.log('\nСтраница раздела не открылась — первые шаги проверять не на чем.');
  await browser.close();
  process.exit(1);
}

check(
  (await main.getByText(/Набор пуст/).count()) > 0,
  'пустой проект встречает первыми шагами, а не пустым списком',
);
for (const step of ['Окружение', 'Генерация', 'Первый прогон']) {
  check((await main.getByText(step, { exact: false }).count()) > 0, `шаг «${step}» назван`);
}
await shot('onboarding-empty');

// Шаг 1: окружение заводится отсюда.
const envButton = main.getByRole('button', { name: /Добавить окружение/ }).first();
check((await envButton.count()) > 0, 'первый шаг делается кнопкой, а не описанием');
await envButton.click();
await page.waitForTimeout(1200);

check(Boolean(savedEnvironment), 'окружение ушло на сервер');
check(savedEnvironment?.isDefault === true, 'первое окружение сразу по умолчанию');
check(Boolean(savedEnvironment?.title), `у окружения есть имя: ${savedEnvironment?.title}`);
check(
  (await main.getByText(/Готово: /).count()) > 0,
  'сделанный шаг помечен сделанным, а не остался призывом',
);
check(
  (await main.getByRole('button', { name: /Добавить окружение/ }).count()) === 0,
  'кнопка сделанного шага исчезла',
);
await shot('onboarding-env-done');

// Шаг 2: генерация запускается отсюда и уходит с выбранным окружением.
const generateButton = main.getByRole('button', { name: /Сгенерировать кейсы/ }).first();
check((await generateButton.count()) > 0, 'второй шаг запускается кнопкой');
await generateButton.click();
await page.waitForTimeout(1200);

check(startBody?.mode === 'generate', `генерация ушла режимом generate: ${startBody?.mode}`);
check(startBody?.path === PROJECT.path, 'генерация адресована открытому проекту');

check(problems.length === 0, `ошибок в консоли нет: ${problems.slice(0, 3).join(' | ')}`);

console.log(bad === 0 ? '\nПервые шаги в порядке.' : `\nПроблем: ${bad}`);
await browser.close();
process.exit(bad === 0 ? 0 : 1);
