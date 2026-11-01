/**
 * Кадры документа «Ядро задач» (`core`): запуск, вопросы, лента, сценарии, плашки отказа.
 *
 * СТЕНД ОДНОРАЗОВЫЙ (`tools/qa/throwaway-stand.mjs`, `core`): своя панель, своё ядро со своим
 * временным домом, настоящий `claude` из PATH человека против сценария `packages/stub-model`
 * (модель — единственное, что подменено; сценарий тот же, что у `tools/qa/check-core-timeline.mjs`).
 * Браузер ходит через прокладку панели `/api/core/*`, ответы ядра не перехватываются — кроме кадра
 * плашки «звено не записано»: стенд записывает себя ядру сам, и показать плашку можно только
 * переписав в ответе `health` поле `trustedHops` (остальной ответ — настоящий).
 *
 * Варианты кадра (тема × язык) снимаются ОДНИМ прогоном: язык и тема — настройкой панели
 * (`applyShotLanguage`) с перезагрузкой страницы. Экран запуска держит форму в памяти страницы,
 * поэтому каждый вариант оценивает свою задачу заново; лента и вопросы живут в ядре и
 * переживают перезагрузку.
 *
 * Запуск: node tools/help-shots/core-panel.mjs (нужен `claude` в PATH; без него — код 2).
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { chromium } from 'playwright';
import { startStand, wait } from '../qa/throwaway-stand.mjs';
import { uuidv7 } from '../qa/core-scenario-stand.mjs';
import { DEFAULT_MASKS, SHOT_VARIANTS, applyShotLanguage, openScenario } from './kit.mjs';

const TOPIC = 'core';
const TIMELINE_QA = join(import.meta.dirname, '..', 'qa', 'check-core-timeline.mjs');
const CHECK_ARGV = ['node', '-e', 'process.exit(0)'];
const CANCEL = 'Отменить задачу';
/** Пути машины съёмки (Windows и POSIX, временные и рабочие) — в кадр не попадает ни один. */
const MASKS = [
  ...DEFAULT_MASKS,
  String.raw`[A-Za-z]:\\[^\s"',;)]+`,
  String.raw`(?:/private)?/(?:tmp|var/folders|home|Users)/[^\s"',;)]+`,
];
const TASK = {
  title: 'README.md: typo',
  request: 'Fix the typo in README.md.',
};
const LABELS = {
  ru: { title: 'Название', request: 'Требования', repo: 'Путь к репозиторию' },
  en: { title: 'Title', request: 'Requirements', repo: 'Repository path' },
};

const where = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['claude'], {
  encoding: 'utf8',
});
const claudeAt = where.status === 0 ? where.stdout.split(/\r?\n/)[0].trim() : '';
if (!claudeAt) {
  console.error('claude не найден в PATH — ленте ядра нужен CLI; кадры не сняты');
  process.exit(2);
}

const git = (cwd, args) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
};
let repo = '';

const stand = await startStand({
  label: 'core-help-shots',
  extraPath: [dirname(claudeAt)],
  core: {
    stub: [
      {
        name: 'stand',
        script: {
          module: TIMELINE_QA,
          export: 'stepDoneScript',
          args: [
            {
              checkArgv: CHECK_ARGV,
              extra: { extracted: [{ text: TASK.request, source: 'request' }] },
            },
          ],
        },
      },
    ],
  },
  seed: ({ root }) => {
    repo = join(root, 'repo');
    mkdirSync(join(repo, '.agentdeck'), { recursive: true });
    git(repo, ['init', '-q', '-b', 'main']);
    git(repo, ['config', 'user.name', 'stand']);
    git(repo, ['config', 'user.email', 'stand@example.invalid']);
    writeFileSync(join(repo, 'README.md'), '# Shop\n\nInstal the app with pnpm.\n');
    // Проверка в реестре репозитория: argv вне реестра ядро отклоняет (`not-registered`).
    writeFileSync(
      join(repo, '.agentdeck', 'checks.json'),
      `${JSON.stringify({ v: 1, checks: [{ id: 'probe', class: 'static', argv: CHECK_ARGV }] })}\n`,
    );
    // Репозиторий пытается включить ожидание CI — ядро отвергает правку, экран запуска это
    // показывает карточкой «Отвергнутые правки».
    writeFileSync(
      join(repo, '.agentdeck', 'scenario.json'),
      JSON.stringify({ v: 1, ciWait: true }),
    );
    git(repo, ['add', '.']);
    git(repo, ['commit', '-qm', 'init']);
  },
});

const token = readFileSync(join(stand.coreHome, 'token'), 'utf8').trim();
const coreUrl = () =>
  JSON.parse(readFileSync(join(stand.coreHome, 'procs.json'), 'utf8')).cores.at(-1).url;

/** Засев прямо в ядро (маршрут и модель задачи — настройка, не экран документа). */
async function direct(method, path, body) {
  const res = await fetch(`${coreUrl()}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let parsed;
  try {
    parsed = text ? JSON.parse(text) : undefined;
  } catch {
    parsed = undefined;
  }
  return { status: res.status, body: parsed, text };
}
async function proof() {
  const page = uuidv7();
  const minted = await direct('GET', `/v1/nonce?page=${page}`);
  return { nonce: minted.body?.nonce, page };
}
async function command(taskId, kind, fields) {
  return direct('POST', '/v1/commands', {
    cmdId: uuidv7(),
    kind,
    target: { taskId },
    fields,
    proof: await proof(),
  });
}
/** Задача ходит только заглушкой: маршрут и модель ставятся сразу за оценкой, как в QA ленты. */
async function pinStubRoute(taskId) {
  const route = await command(taskId, 'set-route', {
    scope: 'task',
    scopeId: taskId,
    allowedRoutes: [
      { adapter: 'claude', route: { kind: 'stub', id: 'stub:stand' }, modelPattern: '*' },
    ],
  });
  const model = await command(taskId, 'set-model', {
    scope: 'task',
    scopeId: taskId,
    model: 'stub-model',
    effort: null,
    timing: 'now',
  });
  if (route.status !== 200 || model.status !== 200) {
    throw new Error(`маршрут/модель задачи ${taskId}: ${route.text} ${model.text}`);
  }
}
function journal(taskId) {
  const dir = join(stand.coreHome, 'tasks', taskId);
  const file = readdirSync(dir).find((f) => f.endsWith('.jsonl'));
  return readFileSync(join(dir, file), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}
async function until(what, probe, seconds) {
  for (let i = 0; i < seconds; i++) {
    const got = await probe();
    if (got) return got;
    await wait(1000);
  }
  throw new Error(`не дождались: ${what}`);
}

/** Перевести панель в вариант кадра и дождаться, что страница его действительно показывает. */
async function toVariant(page, variant, url) {
  await applyShotLanguage(stand.apiUrl, variant.lang, variant.theme);
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    ([lang, theme]) =>
      document.documentElement.lang.startsWith(lang) &&
      document.documentElement.dataset.theme === theme,
    [variant.lang, variant.theme],
    { timeout: 90_000 },
  );
}

/** Кадр области: прокрутить к ней (у панели своя прокрутка) и снять с полями. */
async function shotArea(scenario, page, id, selector, padding = 16) {
  const el = page.locator(selector).first();
  await el.waitFor({ timeout: 60_000 });
  await el.evaluate((node) => node.scrollIntoView({ block: 'center' }));
  await page.mouse.move(2, 2);
  await wait(500);
  await scenario.shot(page, id, { clip: selector, padding, maskText: MASKS });
}
async function shotWindow(scenario, page, id) {
  await page.mouse.move(2, 2);
  await wait(500);
  await scenario.shot(page, id, { maskText: MASKS });
}

/** Сценарий на вариант: открыть, снять, закрыть — описи разных вариантов не перебивают друг друга. */
async function eachVariant(page, name, url, body) {
  for (const variant of SHOT_VARIANTS) {
    console.log(`\nсценарий ${TOPIC}/${name} [${variant.key}]`);
    await toVariant(page, variant, url);
    const scenario = openScenario(TOPIC, name, variant.lang, variant.theme);
    await body(scenario, variant);
    scenario.finish();
  }
}

let exitCode = 0;
const browser = await chromium.launch();
try {
  const page = await stand.newPage(browser, { width: 1280, height: 900 });
  const taskIds = [];

  // Оценка из формы: ответ ядра доходит до браузера настоящим, а маршрут-заглушка ставится за ним
  // вслед — так же быстро, как в QA ленты, до первого шага задачи.
  await page.route('**/api/core/estimate', async (route) => {
    const response = await route.fetch();
    const body = await response.json().catch(() => ({}));
    if (body.taskId && !taskIds.includes(body.taskId)) {
      taskIds.push(body.taskId);
      await pinStubRoute(body.taskId);
    }
    await route.fulfill({ response, json: body });
  });

  // ── Запуск: форма → оценка и дороги → деление ─────────────────────────────────────────────
  // Высокое окно: карточка дорог выше обычного экрана, а кадр области не выходит за окно.
  await page.setViewportSize({ width: 1280, height: 1500 });
  await eachVariant(page, 'launch', `${stand.webUrl}/core/launch`, async (scenario, variant) => {
    const form = page.locator('[data-core-launch-form]');
    await form.waitFor({ timeout: 90_000 });
    const labels = LABELS[variant.lang];
    await form.getByLabel(labels.title, { exact: true }).fill(TASK.title);
    await form.getByLabel(labels.request, { exact: true }).fill(TASK.request);
    await form.getByLabel(labels.repo, { exact: true }).fill(repo);
    await form.locator('select').first().selectOption('preset:bug-fix');
    await shotArea(scenario, page, '01-form', '[data-launch-section="form"]');
    await page.locator('[data-estimate-button]').click();
    await page.locator('[data-launch-section="roads"]').waitFor({ timeout: 90_000 });
    await shotArea(scenario, page, '02-estimate', '[data-launch-section="estimate"]');
    await shotArea(scenario, page, '03-roads', '[data-launch-section="roads"]');
    await shotArea(scenario, page, '04-rejected', '[data-launch-section="rejected"]');
    // Деление приходит потоком после первого шага плана — ждём карточку с единицами.
    await page
      .locator('[data-split-unit]')
      .first()
      .waitFor({ timeout: 240_000 })
      .catch(() => console.log('  деление не пришло — кадр с ожиданием'));
    await shotArea(scenario, page, '05-split', '[data-launch-section="split"]');
    await shotArea(scenario, page, '06-launch', '[data-launch-section="launch"]');
  });
  await page.setViewportSize({ width: 1280, height: 900 });

  const taskId = taskIds[0];
  if (!taskId) throw new Error('оценка из формы не создала задачу');
  const taskUrl = `${stand.webUrl}/core?id=${taskId}`;

  // ── Вопрос запуска на ленте ───────────────────────────────────────────────────────────────
  const launchAsk = await until(
    'вопрос запуска в журнале',
    () => journal(taskId).find((l) => l.kind === 'human.asked' && l.data?.source === 'launch'),
    240,
  );
  await eachVariant(page, 'ask', taskUrl, async (scenario) => {
    await shotArea(scenario, page, '01-launch', '[data-core-ask][data-ask-source="launch"]');
  });
  const answered = page.waitForResponse(
    (r) => r.request().method() === 'POST' && /\/api\/core\/commands$/.test(r.url()),
  );
  await page
    .locator('[data-core-ask][data-ask-source="launch"] [data-ask-option="approve-split"]')
    .click();
  const reply = await (await answered).json().catch(() => ({}));
  if (reply.status !== 'applied') {
    console.log(`  ответ с карточки не принят (${JSON.stringify(reply)}) — прямо в ядро`);
    const r = await command(taskId, 'approve-split', {
      splitId: launchAsk.data.dedupe.slice('split:'.length),
    });
    if (r.body?.status !== 'applied') throw new Error(`ответ запуска: ${r.text}`);
  }

  // ── Вопрос исчерпанных кругов ─────────────────────────────────────────────────────────────
  const capAsk = await until(
    'вопрос исчерпанных кругов',
    () =>
      journal(taskId).find(
        (l) =>
          l.kind === 'human.asked' &&
          l.data?.source === 'round-cap' &&
          !journal(taskId).some(
            (a) => a.kind === 'human.answered' && a.data?.askId === l.data.askId,
          ),
      ),
    300,
  );
  const capId = capAsk.data.askId;
  await until(
    'карточка вопроса кругов',
    async () => {
      await page.goto(taskUrl, { waitUntil: 'domcontentloaded' });
      return page
        .locator(`[data-core-ask="${capId}"]`)
        .waitFor({ timeout: 10_000 })
        .then(() => true)
        .catch(() => false);
    },
    60,
  );
  await eachVariant(page, 'cap', taskUrl, async (scenario) => {
    await shotArea(scenario, page, '01-round-cap', `[data-core-ask="${capId}"]`);
  });
  const late = await command(taskId, 'answer', { askId: capId, answer: CANCEL });
  if (late.body?.status !== 'applied') throw new Error(`ответ на вопрос кругов: ${late.text}`);

  await until(
    'итоговый отчёт ядра',
    async () => (await stand.api(`/core/tasks/${taskId}`)).body?.view?.report,
    300,
  );

  // ── Лента после конца: обзор, решение с «почему», проверка с записью, отчёт ──────────────
  await eachVariant(page, 'timeline', taskUrl, async (scenario) => {
    await page.locator('[data-core-timeline]').waitFor({ timeout: 60_000 });
    await page.locator('[data-core-report]').waitFor({ timeout: 60_000 });
    await wait(1500);
    await shotWindow(scenario, page, '01-overview');

    // Решение, у которого есть причины: раскрыть «детали».
    const decision = page.locator('li[data-core-row]:has([data-decision-class] details)').nth(2);
    await decision.locator('summary').first().click();
    await decision.evaluate((node) => node.setAttribute('data-help-focus', 'decision'));
    await shotArea(scenario, page, '02-decision', '[data-help-focus="decision"]', 24);

    const link = page.locator('[data-record-link]').first();
    await link.scrollIntoViewIfNeeded();
    await link.click();
    await page.locator('[data-record-peek] [data-record-verdict]').first().waitFor({
      timeout: 20_000,
    });
    await shotArea(scenario, page, '03-check', 'li[data-core-row]:has([data-record-peek])', 16);

    await shotArea(scenario, page, '04-report', '[data-core-report]');
  });

  // ── Список задач и плашка «звено не записано» ─────────────────────────────────────────────
  let hopsGone = false;
  await page.route('**/api/core/health', async (route) => {
    if (!hopsGone) return route.continue();
    const response = await route.fetch();
    const body = await response.json();
    await route.fulfill({
      response,
      json: { ...body, trustedHops: { count: 0, recordedAt: null } },
    });
  });
  await eachVariant(page, 'tasks', `${stand.webUrl}/core`, async (scenario) => {
    await page.locator('[data-core-task-list]').waitFor({ timeout: 60_000 });
    await wait(1000);
    await shotWindow(scenario, page, '01-list');
    hopsGone = true;
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.locator('[data-core-hops="unrecorded"]').waitFor({ timeout: 30_000 });
    await shotArea(scenario, page, '02-hops', '[data-core-hops="unrecorded"]');
    hopsGone = false;
  });

  // ── Сценарии: библиотека и редактор нового ────────────────────────────────────────────────
  // Вкладка явно в адресе: страница помнит последнюю вкладку, и голый адрес после кадра
  // нового сценария открыл бы снова его, а не библиотеку.
  await eachVariant(
    page,
    'scenarios',
    `${stand.webUrl}/core/scenarios?tab=library`,
    async (scenario) => {
      await page.locator('[data-scenario-library]').waitFor({ timeout: 60_000 });
      await wait(1000);
      await shotWindow(scenario, page, '01-library');
      await page.goto(`${stand.webUrl}/core/scenarios?tab=new&id=bug-fix@1`, {
        waitUntil: 'domcontentloaded',
      });
      await page.locator('[data-scenario-editor]').waitFor({ timeout: 60_000 });
      await wait(1000);
      await shotWindow(scenario, page, '02-new');
    },
  );

  // ── Ядро остановлено: карточка «не запущено» ──────────────────────────────────────────────
  process.kill(stand.corePid());
  await wait(2000);
  await eachVariant(page, 'absent', `${stand.webUrl}/core`, async (scenario) => {
    await shotArea(scenario, page, '01-card', '[data-core-refusal="core-absent"]', 24);
  });
} catch (error) {
  console.error(error instanceof Error ? (error.stack ?? error.message) : error);
  exitCode = 1;
} finally {
  await browser.close();
  await stand.stop();
}
process.exit(exitCode);
