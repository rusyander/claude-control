/**
 * Слова раздела «Тесты», которые раньше приезжали с сервера по-русски.
 *
 *  - «Прошёл только на повторе» (F-355): импорт писал фразу в заметку прохода и
 *    кейса, и английский интерфейс показывал её как есть. Теперь это число
 *    `flakyAttempts` у прохода и `flaky {attempts, runId}` у кейса; слова берёт
 *    словарь. Проверяются три места: запись прогона, сравнение с прошлым прогоном
 *    и карточка кейса.
 *  - Сломанный файл обвязки (F-356): причина едет кодом, окно настроек называет
 *    её на языке интерфейса, а не русской строкой сервера.
 *
 * Оба языка: русский — что слова на месте, английский — что русских нет.
 * Ответы сервера подменены целиком, проект живёт только в этой проверке: ни
 * истории, ни установленного CLI не нужно, настоящий реестр стенда не трогается.
 *
 * Запуск: `node tools/qa/check-tests-server-words.mjs` при поднятом `pnpm dev`.
 * Снимки: `SHOTS=<каталог> node tools/qa/check-tests-server-words.mjs`.
 */
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { bypassOnboarding } from './bypass-onboarding.mjs';

const BASE = process.env.APP_URL ?? 'http://localhost:8888';
const PROJECT = { name: 'QA проект', path: 'C:/qa-project' };

const RUN = {
  id: 'run-2',
  mode: 'import',
  actor: 'ci',
  origin: 'e2e',
  status: 'done',
  startedAt: '2026-09-08T10:00:00.000Z',
  finishedAt: '2026-09-08T10:05:00.000Z',
  results: [
    {
      pointId: 'gui:gui-001',
      groupId: 'gui',
      caseId: 'gui-001',
      status: 'passed',
      flakyAttempts: 2,
    },
  ],
  summary: { total: 1, passed: 1, failed: 0, skipped: 0, blocked: 0 },
};

const DIFF = {
  from: {
    id: 'run-1',
    startedAt: '2026-09-07T10:00:00.000Z',
    mode: 'import',
    summary: { total: 1, passed: 0, failed: 1, skipped: 0, blocked: 0 },
  },
  to: { id: 'run-2', startedAt: RUN.startedAt, mode: 'import', summary: RUN.summary },
  newFailures: [],
  fixed: [
    {
      groupId: 'gui',
      caseId: 'gui-001',
      title: 'Открытие настроек',
      from: 'failed',
      to: 'passed',
      flakyAttempts: 2,
    },
  ],
  stillFailing: [],
  untouched: [],
  added: [],
  removed: [],
  comparable: true,
};

const view = {
  projectPath: PROJECT.path,
  dir: '.agent/tests',
  hasConvention: true,
  sharedSteps: [],
  environments: [],
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
          title: 'Открытие настроек',
          steps: [{ action: 'открыть настройки' }],
          status: 'passed',
          source: 'agent',
          lastRunId: 'run-2',
          lastRunAt: RUN.finishedAt,
          flaky: { attempts: 2, runId: 'run-2' },
        },
      ],
    },
  ],
  libraryIssues: [
    {
      file: '.agent/tests/automation.json',
      error: 'В файле команды прогона нет строки «command».',
      messageCode: 'automation-command-missing',
    },
  ],
};

const WORDS = {
  ru: {
    retry: 'прошёл только на повторе (упавших попыток: 2)',
    issue: 'В файле команды прогона нет строки «command».',
    settings: 'Настройки набора',
    edit: 'Правка теста',
    compare: 'Сравнить с предыдущим',
  },
  en: {
    retry: 'passed only on a retry (failed attempts: 2)',
    issue: 'The run command file has no “command” string.',
    settings: 'Library settings',
    edit: 'Edit test',
    compare: 'Compare with the previous run',
  },
};

let bad = 0;
const check = (ok, text) => {
  console.log(`${ok ? 'ок  ' : 'ПЛОХО'} ${text}`);
  if (!ok) bad += 1;
};

const shotsDir = process.env.SHOTS;
const browser = await chromium.launch();

for (const lang of ['ru', 'en']) {
  const words = WORDS[lang];
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  await bypassOnboarding(page, { language: lang });
  const problems = [];
  page.on('pageerror', (error) => problems.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') problems.push(message.text());
  });
  const shot = async (name) => {
    if (!shotsDir) return;
    await mkdir(shotsDir, { recursive: true });
    await page.screenshot({ path: join(shotsDir, `${name}-${lang}.png`), fullPage: true });
  };

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
          lastActivity: RUN.startedAt,
          chats: [],
        },
      ],
    }),
  );
  // Порядок важен: Playwright берёт ПОСЛЕДНИЙ подходящий обработчик, а `**/run*`
  // подходит и к `/runs`, и к `/run/diff`.
  await page.route('**/api/project-tests/run*', async (route) =>
    route.fulfill({ json: { run: RUN } }),
  );
  await page.route('**/api/project-tests/runs*', async (route) =>
    route.fulfill({ json: { runs: [RUN] } }),
  );
  await page.route('**/api/project-tests/run/diff*', async (route) =>
    route.fulfill({ json: DIFF }),
  );
  await page.route('**/api/project-tests/lint*', async (route) =>
    route.fulfill({ json: { checked: 1, findings: [], byRule: [], duplicates: [] } }),
  );
  await page.route('**/api/project-tests/quarantine*', async (route) =>
    route.fulfill({
      json: {
        lift: [],
        quarantine: [],
        stale: [],
        thresholds: { greenStreak: 5, stability: 70, minRuns: 4 },
        checkedAt: RUN.startedAt,
      },
    }),
  );
  await page.route('**/api/project-tests/risk*', async (route) =>
    route.fulfill({ json: { items: [], checkedAt: RUN.startedAt } }),
  );
  await page.route('**/api/project-tests/plans*', async (route) =>
    route.fulfill({ json: { plans: [] } }),
  );
  await page.route('**/api/project-tests/manual*', async (route) => route.fulfill({ json: {} }));
  await page.route('**/api/project-tests/impact*', async (route) =>
    route.fulfill({ json: { files: [], cases: [] } }),
  );
  await page.route('**/api/project-tests/env-secrets*', async (route) =>
    route.fulfill({ json: { secrets: [] } }),
  );
  await page.route('**/api/project-tests?*', async (route) => route.fulfill({ json: view }));
  await page.route('**/api/project-tests/flaky*', async (route) =>
    route.fulfill({ json: { window: 10, minFlips: 2, cases: [] } }),
  );
  await page.route('**/api/project-tests/case-history*', async (route) =>
    route.fulfill({
      json: {
        groupId: 'gui',
        caseId: 'gui-001',
        entries: [],
        flaky: { isFlaky: false, flips: 0, runs: 0 },
      },
    }),
  );

  await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
  await page.evaluate((project) => {
    localStorage.setItem(
      'agentdeck:workspace',
      JSON.stringify({
        projectTabs: [{ id: project.path.toLowerCase(), path: project.path, name: project.name }],
        activeTabId: project.path.toLowerCase(),
        views: {},
      }),
    );
    localStorage.setItem('agentdeck:tests-project', project.path.toLowerCase());
  }, PROJECT);

  // 1. Запись прогона: у зелёного на повторе — отметка словами словаря.
  await page.goto(`${BASE}/tests?tab=runs`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('nav');
  await page.waitForTimeout(2200);
  const main = page.getByRole('main').or(page.locator('body')).first();
  const head = main.locator('[id^="run-card-"] button[aria-expanded]').first();
  check((await head.count()) > 0, `${lang}: запись прогона на месте`);
  if ((await head.count()) > 0) {
    await head.click();
    await page.waitForTimeout(1200);
  }
  check(
    (await main.getByText(words.retry, { exact: true }).count()) > 0,
    `${lang}: в записи прогона — «${words.retry}»`,
  );
  // Сравнение с прошлым: «починился» — но только на повторе.
  const compare = main.getByRole('button', { name: words.compare }).first();
  if ((await compare.count()) > 0) {
    await compare.click();
    await page.waitForTimeout(1200);
  }
  check(
    (await main.getByText(words.retry, { exact: true }).count()) > 1,
    `${lang}: в сравнении прогонов у починившегося кейса та же отметка`,
  );
  await shot('retry-run');

  // 2. Карточка кейса: признак последнего результата.
  await page.goto(`${BASE}/tests`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('nav');
  const row = page.getByRole('row').filter({ hasText: 'Открытие настроек' });
  await row.first().waitFor({ timeout: 30_000 });
  await row.first().getByRole('button', { name: words.edit }).click();
  const editor = page.getByRole('dialog', { name: words.edit });
  await editor.waitFor();
  await page.waitForTimeout(500);
  check(
    (await editor.getByText(words.retry, { exact: true }).count()) > 0,
    `${lang}: в карточке кейса — «${words.retry}»`,
  );
  await shot('retry-case');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(500);

  // 3. Окно настроек: сломанная команда прогона названа на языке интерфейса.
  await page.getByRole('button', { name: words.settings }).first().click();
  const settings = page.getByRole('dialog').first();
  await settings.waitFor();
  await page.waitForTimeout(500);
  check(
    (await settings.getByText(words.issue, { exact: false }).count()) > 0,
    `${lang}: причина сломанного файла — «${words.issue}»`,
  );
  await shot('library-issue');

  if (lang === 'en') {
    const text = await page.locator('body').innerText();
    for (const russian of ['повторе', 'упавших', 'команды прогона']) {
      check(!text.includes(russian), `en: русского «${russian}» на экране нет`);
    }
  }
  check(
    problems.length === 0,
    `${lang}: ошибок в консоли нет${problems.length ? `: ${problems[0]}` : ''}`,
  );
  await page.close();
}

console.log(bad === 0 ? '\nСлова сервера в «Тестах»: всё на месте.' : `\nПроблем: ${bad}`);
await browser.close();
process.exit(bad === 0 ? 0 : 1);
