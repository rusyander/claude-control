/**
 * Прокладка панели к ядру задач (этап 9, волна 0) на одноразовом стенде с настоящим ядром.
 *
 * Что проверяется:
 * 1. Ядро стенда записало себя в `procs.json` своего временного дома на loopback вне 5170–5180.
 * 2. Ручки списка контрактов доходят до ядра через панель: health 200, список задач пуст,
 *    маршруты — список с возможностями (`caps`), запись по неверному id — 400 `bad-id`, отчёт
 *    задачи, которой нет, — 404 `no-task`, поток событий чужой задачи — 404 ядра.
 * 3. F10: строка `procs.json` с pid, который не слушает порт, — 503 `core-unverified`
 *    (токен не ушёл); исходная строка — снова 200.
 * 4. Раздел `/core` в браузере: пустой список задач; ядро убито — карточка «Ядро задач не
 *    запущено» (строка осталась, процесса нет — `core-absent`).
 *
 * Ядро — `apps/core` своим процессом, маршруты моделей — только заглушки `packages/stub-model`.
 * Запуск: `node tools/qa/check-core-panel-api.mjs`; `SHOTS=<папка>` — снимки раздела.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { runOnStand, wait } from './throwaway-stand.mjs';

const SHOTS = process.env.SHOTS;
const NO_TASK = '01900000-0000-7000-8000-000000000000';

await runOnStand({ label: 'core-panel', core: true }, async (stand, check) => {
  const procsPath = join(stand.coreHome, 'procs.json');
  const procsText = readFileSync(procsPath, 'utf8');
  const row = JSON.parse(procsText).cores.at(-1);
  check(
    'ядро записало строку на loopback вне 5170–5180',
    row && /^http:\/\/127\.0\.0\.1:\d+$/.test(row.url) && (row.port < 5170 || row.port > 5180),
    JSON.stringify(row),
  );

  const health = await stand.api('/core/health');
  check(
    'health через панель — 200 от ядра',
    health.status === 200 && health.body?.ok === true,
    health.text,
  );
  const tasks = await stand.api('/core/tasks');
  check(
    'список задач через панель — пустой',
    tasks.status === 200 && Array.isArray(tasks.body?.tasks) && tasks.body.tasks.length === 0,
    tasks.text,
  );
  // Чтения этапа 9 отвечают своими кодами: маршруты — список с возможностями из реестра,
  // запись по неверному id — 400, отчёт задачи, которой нет, — 404.
  const routes = await stand.api('/core/routes');
  const routeList = Array.isArray(routes.body?.routes) ? routes.body.routes : [];
  check(
    '/core/routes — 200, у каждого маршрута caps объектом',
    routes.status === 200 &&
      routeList.length > 0 &&
      routeList.every(
        (r) => r.caps && typeof r.caps === 'object' && Array.isArray(r.caps.dialects),
      ),
    `${routes.status} ${routes.text.slice(0, 300)}`,
  );
  const record = await stand.api('/core/records/r-1');
  check(
    '/core/records/r-1 — 400 bad-id от ядра',
    record.status === 400 && record.body?.code === 'bad-id',
    `${record.status} ${record.text}`,
  );
  const report = await stand.api(`/core/tasks/${NO_TASK}/report`);
  check(
    'отчёт задачи, которой нет, — 404 no-task от ядра',
    report.status === 404 && report.body?.code === 'no-task',
    `${report.status} ${report.text}`,
  );
  const events = await stand.api(`/core/tasks/${NO_TASK}/events`);
  check(
    'поток событий чужой задачи — 404 ядра',
    events.status === 404 && events.body?.code === 'no-task',
    `${events.status} ${events.text}`,
  );
  const outside = await stand.api('/core/session/hook', { method: 'POST', body: {} });
  check(
    'ручка вне списка контрактов до ядра не доходит — 404 панели',
    outside.status === 404,
    outside.text,
  );

  // F10: подменённая строка — pid живой панели стенда, порт ядра. Токен уйти не должен.
  writeFileSync(
    procsPath,
    JSON.stringify({ ...JSON.parse(procsText), cores: [{ ...row, pid: stand.serverPid() }] }),
  );
  const forged = await stand.api('/core/tasks');
  writeFileSync(procsPath, procsText);
  check(
    'строка с чужим pid — 503 core-unverified',
    forged.status === 503 &&
      forged.body?.code === 'core-unverified' &&
      forged.body?.messageCode === 'core-unverified',
    `${forged.status} ${forged.text}`,
  );
  const restored = await stand.api('/core/tasks');
  check('исходная строка — снова 200', restored.status === 200, restored.text);

  const browser = await chromium.launch();
  try {
    const page = await stand.newPage(browser);
    await page.goto(`${stand.webUrl}/core`);
    await page.getByText('Задач пока нет').waitFor({ timeout: 20_000 });
    check('раздел /core: пустой список задач ядра', true);
    if (SHOTS) {
      mkdirSync(SHOTS, { recursive: true });
      await page.screenshot({ path: join(SHOTS, 'core-tasks-empty_AFTER.png') });
    }

    process.kill(stand.corePid());
    await wait(1500);
    const absent = await stand.api('/core/tasks');
    check(
      'ядро убито, строка осталась — 503 core-absent',
      absent.status === 503 && absent.body?.code === 'core-absent',
      `${absent.status} ${absent.text}`,
    );
    await page.reload();
    const card = page.locator('[data-core-refusal="core-absent"]');
    await card.waitFor({ timeout: 20_000 });
    const text = await card.innerText();
    check('карточка «Ядро задач не запущено»', text.includes('Ядро задач не запущено'), text);
    if (SHOTS) await page.screenshot({ path: join(SHOTS, 'core-tasks-absent_AFTER.png') });
    check('страница без ошибок', page.errors.length === 0, page.errors.join('\n'));
  } finally {
    await browser.close();
  }
});
