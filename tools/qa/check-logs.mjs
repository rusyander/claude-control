/**
 * Окно «Окружение», вкладка «Логи» — живой стенд, настоящие процессы,
 * настоящий UI.
 *
 * Одноразовая панель (`throwaway-stand.mjs`), в ней проект с node-сервисом,
 * который «Dev-сервер» запускает по-настоящему: сервис пишет JSON и обычные
 * строки разных уровней, ошибку со стеком в stderr, секреты (пароль, токен) и
 * тикает раз в 400 мс. Если docker работает — рядом стек Compose из двух
 * сервисов alpine (имя уникально на прогон, метка `claude.ephemeral`, в конце
 * `down`). Что проверяется:
 *
 * - API: источники (цель, сервисы, «все сервисы»); первый ответ — хвост,
 *   следующий по курсору — только новое, без повторов; поток stderr помечен;
 *   чужой каталог — 403, неизвестный источник — 404; остановленная цель —
 *   idle и вывод последнего запуска; перезапуск — reset по старому курсору;
 *   Compose: строки сервиса, по курсору — строго новее, «все сервисы» —
 *   с именами;
 * - UI: вкладка, уровни с порогом «и важнее» (стек ошибки остаётся с ней),
 *   поиск с подсветкой и счётчиком, слежение у последней строки, прокрутка
 *   вверх выключает его и показывает «К новым строкам (N)», кнопка
 *   возвращает; JSON-строка раскрывается полями; «Разобрать в чате» кладёт
 *   просьбу со строкой и контекстом в поле чата — секреты замаскированы, окно
 *   закрыто, фокус в поле; источник «все сервисы» подписывает строки;
 * - axe в светлой и тёмной теме.
 *
 * Запуск: `node tools/qa/check-logs.mjs`. Снимки — в
 * `.agent/screenshots/before-after/backend-logs/`.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { AxeBuilder } from '@axe-core/playwright';
import { NotChecked, REPO, freePort, runOnStand, wait } from './throwaway-stand.mjs';
import { seedChatTranscript } from './backend-fixtures.mjs';

const SHOTS = join(REPO, '.agent', 'screenshots', 'before-after', 'backend-logs');
mkdirSync(SHOTS, { recursive: true });
const RUN_TAG = Date.now().toString(36);
const PASSWORD = `qa-pass-${RUN_TAG}`;
const TOKEN = `qa-tok-${RUN_TAG}`;
const COMPOSE_NAME = `qa-logs-${RUN_TAG}`;

const docker = (args, cwd) =>
  spawnSync('docker', args, { cwd, encoding: 'utf8', windowsHide: true, timeout: 120_000 });
const dockerUp = docker(['info', '--format', '{{.ServerVersion}}']).status === 0;

const SERVER_JS = (port) => `const http = require('node:http');
const PORT = Number(process.env.PORT || ${port});
console.log(JSON.stringify({ level: 'info', msg: 'boot', version: '1.0.0' }));
console.log('level=warn msg="disk 91% full"');
console.error('[ERROR] payment failed password=${PASSWORD} user=bob');
console.error('    at charge (pay.js:10:5)');
console.error('    at main (index.js:3:1)');
console.log(JSON.stringify({ level: 'error', msg: 'db down', attempt: 3, token: '${TOKEN}' }));
let n = 0;
setInterval(() => console.log(JSON.stringify({ level: 'debug', msg: 'tick', n: n++ })), 400);
http.createServer((req, res) => res.end('ok')).listen(PORT, '127.0.0.1', () => {
  console.log('Listening on http://127.0.0.1:' + PORT);
});
`;

const COMPOSE_YAML = `name: ${COMPOSE_NAME}
services:
  api:
    image: alpine:3.20
    command: ["sh", "-c", "echo '{\\"level\\":\\"error\\",\\"msg\\":\\"api boom\\"}'; i=0; while true; do echo \\"api tick $$i\\"; i=$$((i+1)); sleep 1; done"]
    labels: [claude.ephemeral=1]
  worker:
    image: alpine:3.20
    command: ["sh", "-c", "i=0; while true; do echo \\"worker WARN job $$i slow\\"; i=$$((i+1)); sleep 1; done"]
    labels: [claude.ephemeral=1]
`;

async function closeKeyGate(page) {
  const close = page.getByRole('button', { name: 'Закрыть', exact: true });
  try {
    await close.first().waitFor({ timeout: 6000 });
    await close.first().click();
  } catch {
    // Окна не было — CLI на стенде нашёлся.
  }
}

/** Чат → проект → «Окружение» → вкладка «Логи». */
async function openLogs(stand, context, projectName) {
  const page = await context.newPage();
  page.errors = [];
  page.on('pageerror', (error) => page.errors.push(error.message));
  await page.goto(`${stand.webUrl}/chat`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('nav');
  await closeKeyGate(page);
  await page.getByRole('tab', { name: 'Проекты' }).first().click({ timeout: 15_000 });
  await page
    .getByRole('button', { name: new RegExp(projectName) })
    .first()
    .click({ timeout: 15_000 });
  await page
    .getByRole('button', { name: /^Окружение$/ })
    .first()
    .click({ timeout: 15_000 });
  const dialog = page.getByRole('dialog', { name: 'Окружение проекта' });
  await dialog.waitFor({ timeout: 15_000 });
  await dialog.getByRole('tab', { name: 'Логи' }).click();
  await wait(500);
  return { page, dialog };
}

async function axe(page) {
  await wait(600);
  const results = await new AxeBuilder({ page })
    .include('[role="dialog"]')
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  return results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
}

const visible = (locator, timeout = 15_000) =>
  locator
    .first()
    .waitFor({ timeout })
    .then(() => true)
    .catch(() => false);

/** Расстояние от низа прокрутки вида — 0, когда видна последняя строка. */
const gapToBottom = (region) =>
  region.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight);

const port = await freePort();
let dirs;

await runOnStand(
  {
    label: 'logs',
    settings: { theme: 'system' },
    seed: ({ root, cfg }) => {
      const app = join(root, 'demo', 'logs-app');
      const stranger = join(root, 'outside', 'stranger');
      for (const dir of [app, stranger]) mkdirSync(dir, { recursive: true });
      writeFileSync(join(app, 'server.js'), SERVER_JS(port), 'utf8');
      writeFileSync(
        join(app, 'package.json'),
        `${JSON.stringify({ name: 'logs-app', private: true, scripts: { dev: 'node server.js' } }, null, 2)}\n`,
        'utf8',
      );
      if (dockerUp) writeFileSync(join(app, 'compose.yaml'), COMPOSE_YAML, 'utf8');
      dirs = { app, stranger };
      seedChatTranscript(cfg, app);
    },
  },
  async (stand, check) => {
    const added = await stand.api('/projects', {
      method: 'POST',
      body: { path: dirs.app, name: 'logs-app' },
    });
    if (added.status >= 300) throw new NotChecked(`проект не добавился: ${added.text}`);
    const q = (path) => `path=${encodeURIComponent(path)}`;
    const logs = (source, cursor, path = dirs.app) =>
      stand.api(
        `/logs?${q(path)}&source=${encodeURIComponent(source)}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
      );
    const sources = async () => (await stand.api(`/logs/sources?${q(dirs.app)}`)).body;

    try {
      if (dockerUp) {
        const up = docker(['compose', 'up', '-d'], dirs.app);
        check('Compose: стек поднят', up.status === 0, up.stderr.slice(-400));
      } else {
        console.log('  · docker не отвечает — часть про Compose не проверялась');
      }

      /* ── API: цель «Dev-сервера» ──────────────────────────────────── */
      const start = await stand.api('/project-runner/start', {
        method: 'POST',
        body: { path: dirs.app },
      });
      check('цель запущена', start.status === 200, start.text);
      let run;
      for (let i = 0; i < 40; i += 1) {
        const runs = (await stand.api('/project-runner')).body;
        run = runs.find((item) => item.projectPath.toLowerCase() === dirs.app.toLowerCase());
        if (run?.status === 'running' || run?.status === 'error') break;
        await wait(500);
      }
      check('цель работает', run?.status === 'running', JSON.stringify(run));

      const list = await sources();
      const runSource = list?.sources?.find((item) => item.kind === 'run');
      check(
        'источники: цель «Dev-сервера» с командой',
        runSource?.label !== undefined && /dev|server\.js/.test(runSource?.detail ?? ''),
        JSON.stringify(list),
      );
      if (dockerUp) {
        const ids = (list?.sources ?? []).map((item) => item.id);
        check(
          'источники: сервисы Compose и «все сервисы»',
          ['compose:api', 'compose:worker', 'compose:*'].every((id) => ids.includes(id)) &&
            list.docker === 'ok',
          ids.join(', '),
        );
      }

      await wait(1500);
      const first = await logs(runSource.id);
      const texts = (first.body?.lines ?? []).map((line) => line.text);
      check(
        'первый ответ: вывод цели с начала',
        texts.some((text) => text.includes('payment failed')) &&
          texts.some((text) => text.includes('"msg":"boot"')),
        texts.slice(0, 8).join(' | '),
      );
      check(
        'stderr помечен потоком',
        first.body?.lines?.find((line) => line.text.includes('payment failed'))?.stream ===
          'stderr' &&
          first.body?.lines?.find((line) => line.text.includes('"msg":"boot"'))?.stream ===
            'stdout',
      );
      check(
        'курсор цели: <startedAt>#<seq>',
        /^.+#\d+$/.test(first.body?.cursor ?? ''),
        first.body?.cursor,
      );
      const ticks = (lines) =>
        lines
          .map((line) => /"msg":"tick","n":(\d+)/.exec(line.text)?.[1])
          .filter(Boolean)
          .map(Number);
      await wait(1300);
      const next = await logs(runSource.id, first.body.cursor);
      const before = ticks(first.body.lines);
      const after = ticks(next.body?.lines ?? []);
      check(
        'по курсору — только новое, без повторов',
        after.length > 0 &&
          after.every((n) => n > Math.max(-1, ...before)) &&
          !next.body.lines.some((line) => line.text.includes('payment failed')),
        `before=${before.join(',')} after=${after.join(',')}`,
      );

      const foreign = await stand.api(`/logs/sources?${q(dirs.stranger)}`);
      check(
        'чужой каталог: 403 logs-project-unregistered',
        foreign.status === 403 && foreign.body?.code === 'logs-project-unregistered',
        foreign.text,
      );
      const unknown = await logs('run:nowhere');
      check(
        'неизвестный источник: 404 logs-source-unknown',
        unknown.status === 404 && unknown.body?.code === 'logs-source-unknown',
        unknown.text,
      );
      const noSource = await stand.api(`/logs?${q(dirs.app)}`);
      check(
        'без источника: 400 logs-source-required',
        noSource.status === 400 && noSource.body?.code === 'logs-source-required',
      );

      /* ── API: Compose ─────────────────────────────────────────────── */
      if (dockerUp) {
        await wait(2500);
        const api1 = await logs('compose:api');
        const apiTexts = (api1.body?.lines ?? []).map((line) => line.text);
        check(
          'Compose: строки сервиса без префикса, со временем',
          apiTexts.some((text) => text.includes('api boom')) &&
            apiTexts.every((text) => !/^api[-\w]*\s+\|/.test(text)) &&
            api1.body.lines.every((line) => Boolean(line.at)),
          apiTexts.slice(0, 4).join(' | '),
        );
        await wait(2200);
        const api2 = await logs('compose:api', api1.body.cursor);
        const num = (text) => Number(/api tick (\d+)/.exec(text)?.[1] ?? -1);
        const lastBefore = Math.max(-1, ...apiTexts.map(num));
        const fresh = (api2.body?.lines ?? []).map((line) => num(line.text));
        check(
          'Compose: по курсору — строго новее',
          fresh.length > 0 && fresh.every((n) => n > lastBefore),
          `last=${lastBefore} fresh=${fresh.join(',')}`,
        );
        const all = await logs('compose:*');
        const services = new Set((all.body?.lines ?? []).map((line) => line.service));
        check(
          'Compose: «все сервисы» — строки подписаны сервисами',
          services.has('api') && services.has('worker'),
          [...services].join(','),
        );
      }

      /* ── UI ───────────────────────────────────────────────────────── */
      const browser = await chromium.launch();
      try {
        const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
        const { page, dialog } = await openLogs(stand, context, 'logs-app');
        const region = dialog.getByRole('region', { name: /^Строки лога/ });
        // Красный без подробностей не классифицировать: называем, чего не дождались.
        const sourcesShown = await visible(dialog.getByRole('navigation', { name: 'Источники' }));
        const regionShown = await visible(region);
        const lineShown = await visible(region.getByText(/payment failed/));
        check(
          'вкладка: источники и строки цели',
          sourcesShown && regionShown && lineShown,
          `источники=${sourcesShown} строки=${regionShown} «payment failed»=${lineShown}` +
            (lineShown ? '' : ` строк в области: ${await region.locator('[data-index]').count()}`),
        );
        await wait(1200);
        check('слежение: вид у последней строки', (await gapToBottom(region)) < 40);

        const levels = dialog.getByRole('group', { name: 'Уровень' });
        const errorsChip = levels.getByRole('button', { name: /^Ошибки/ });
        check(
          'порог «Ошибки»: число — строки ошибок со стеком',
          /Ошибки\s*4/.test((await errorsChip.textContent()) ?? ''),
          await errorsChip.textContent(),
        );
        await errorsChip.click();
        await wait(400);
        const shownErrors = await region.locator('button[aria-expanded]').allTextContents();
        check(
          'порог «Ошибки»: ошибки и их стек, без тиков и info',
          shownErrors.length === 4 &&
            shownErrors.some((text) => text.includes('at charge')) &&
            !shownErrors.some((text) => /tick|boot/.test(text)),
          shownErrors.join(' | '),
        );
        await page.screenshot({ path: join(SHOTS, 'logs-errors_AFTER.png') });
        await levels.getByRole('button', { name: /^Все\s*\d+$/ }).click();

        const search = dialog.getByRole('searchbox', { name: 'Поиск по строкам' });
        await search.fill('DISK');
        await wait(500);
        check(
          'поиск без учёта регистра: одна строка, подсветка, счётчик',
          (await region.locator('button[aria-expanded]').count()) === 1 &&
            (await region.locator('mark').count()) === 1 &&
            (await visible(dialog.getByText(/^1 из \d+$/))),
        );
        await search.fill('');
        await wait(400);

        // Человек крутит вверх — слежение выключается, новые строки копятся в кнопке.
        await region.hover();
        await page.mouse.wheel(0, -4000);
        await wait(1800);
        const follow = dialog.getByRole('switch', { name: 'Следить' });
        const newLines = dialog.getByRole('button', { name: /^К новым строкам \(\d+\)$/ });
        check(
          'прокрутка вверх: слежение выключено, «К новым строкам (N)»',
          (await follow.getAttribute('aria-checked')) === 'false' &&
            (await visible(newLines, 4000)),
          `aria-checked=${await follow.getAttribute('aria-checked')}`,
        );
        await page.screenshot({ path: join(SHOTS, 'logs-new-lines_AFTER.png') });
        await newLines.click();
        await wait(900);
        check(
          '«К новым строкам»: снова внизу, слежение включено, кнопки нет',
          (await gapToBottom(region)) < 40 &&
            (await follow.getAttribute('aria-checked')) === 'true' &&
            (await newLines.count()) === 0,
        );

        await search.fill('db down');
        await wait(500);
        await region.locator('button[aria-expanded]').first().click();
        check(
          'JSON-строка раскрывается полями записи',
          (await visible(dialog.getByRole('definition').filter({ hasText: /^3$/ }))) &&
            (await visible(dialog.locator('dt', { hasText: /^token$/ }))),
        );
        const violationsLight = await axe(page);
        check(
          'axe (светлая, раскрытая строка): без серьёзных',
          violationsLight.length === 0,
          violationsLight.map((v) => `${v.id}: ${v.nodes[0]?.target}`).join(', '),
        );
        await page.screenshot({ path: join(SHOTS, 'logs-json-detail_AFTER.png') });

        await dialog.getByRole('button', { name: 'Разобрать в чате' }).click();
        const composer = page.locator('[data-chat-input]');
        check(
          '«Разобрать в чате»: окно закрылось',
          (await dialog.isHidden({ timeout: 5000 }).catch(() => false)) ||
            !(await dialog.isVisible()),
        );
        const draft = await composer.first().evaluate((el) => el.value ?? el.textContent ?? '');
        check(
          '«Разобрать в чате»: строка и контекст в поле чата',
          draft.includes('Строка:') &&
            draft.includes('"msg":"db down"') &&
            draft.includes('payment failed'),
          draft.slice(0, 300),
        );
        check(
          '«Разобрать в чате»: секреты замаскированы',
          !draft.includes(PASSWORD) &&
            !draft.includes(TOKEN) &&
            draft.includes('password=••••') &&
            draft.includes('"token":"••••"'),
          draft.slice(0, 600),
        );
        check(
          'фокус в поле чата',
          await composer.first().evaluate((el) => el === document.activeElement),
        );
        await page.screenshot({ path: join(SHOTS, 'logs-ask-agent_AFTER.png') });

        if (dockerUp) {
          await page
            .getByRole('button', { name: /^Окружение$/ })
            .first()
            .click();
          await dialog.waitFor();
          await dialog.getByRole('tab', { name: 'Логи' }).click();
          // Поиск живёт у вкладки, а не у источника: сбросить, чтобы видеть сервисы целиком.
          const again = dialog.getByRole('searchbox', { name: 'Поиск по строкам' });
          if (await again.inputValue()) await again.fill('');
          await dialog.getByRole('button', { name: /^Все сервисы/ }).click();
          const allRegion = dialog.getByRole('region', { name: 'Строки лога «Все сервисы»' });
          check(
            'UI «Все сервисы»: строки подписаны сервисами',
            (await visible(allRegion.getByText('worker', { exact: true }))) &&
              (await visible(allRegion.getByText('api', { exact: true }))),
          );
          await page.screenshot({ path: join(SHOTS, 'logs-compose-all_AFTER.png') });
          await dialog.getByRole('button', { name: /^worker/ }).click();
          const workerRegion = dialog.getByRole('region', { name: 'Строки лога «worker»' });
          check(
            'UI сервис: свои строки, уровень распознан',
            (await visible(workerRegion.getByText(/^worker WARN job \d+ slow$/))) &&
              (await visible(workerRegion.getByText('WARN', { exact: true }))),
          );
        }
        check('без ошибок страницы', page.errors.length === 0, page.errors.join(' | '));
        await context.close();

        const darkContext = await browser.newContext({
          viewport: { width: 1440, height: 1000 },
          colorScheme: 'dark',
        });
        const dark = await openLogs(stand, darkContext, 'logs-app');
        await visible(dark.dialog.getByText(/payment failed/));
        const violationsDark = await axe(dark.page);
        check(
          'axe (тёмная, поток цели): без серьёзных',
          violationsDark.length === 0,
          violationsDark.map((v) => `${v.id}: ${v.nodes[0]?.target}`).join(', '),
        );
        await dark.page.screenshot({ path: join(SHOTS, 'logs-run-dark_AFTER.png') });
        await darkContext.close();
      } finally {
        await browser.close();
      }

      // Веб-цель на стенде не открывает браузер ОС (AGENTDECK_OPEN_BROWSER=0): иначе
      // окно с домом стенда в профиле висит у человека и держит каталог стенда.
      if (process.platform === 'win32') {
        const stray = spawnSync(
          'powershell',
          [
            '-NoProfile',
            '-Command',
            `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match ':${port}/' -and $_.Name -notmatch '^(node|powershell)' } | Select-Object -ExpandProperty Name`,
          ],
          { encoding: 'utf8', windowsHide: true, timeout: 30_000 },
        );
        check(
          'браузер ОС не открывался на адрес цели',
          stray.status === 0 && stray.stdout.trim() === '',
          stray.stdout.trim() || stray.stderr.trim(),
        );
      }

      /* ── API: остановка и перезапуск ──────────────────────────────── */
      const lastCursor = (await logs(runSource.id)).body?.cursor;
      await stand.api('/project-runner/stop', { method: 'POST', body: { path: dirs.app } });
      await wait(1200);
      const stopped = await logs(runSource.id, lastCursor);
      const stoppedFull = await logs(runSource.id);
      check(
        'остановлена: idle, вывод последнего запуска на месте',
        stopped.body?.idle === true &&
          (stoppedFull.body?.lines ?? []).some((line) => line.text.includes('payment failed')),
        stopped.text.slice(0, 300),
      );
      await stand.api('/project-runner/start', { method: 'POST', body: { path: dirs.app } });
      await wait(2500);
      const restarted = await logs(runSource.id, lastCursor);
      check(
        'перезапуск: старый курсор → reset, строки нового запуска',
        restarted.body?.reset === true &&
          (restarted.body?.lines ?? []).some((line) => line.text.includes('"msg":"boot"')),
        restarted.text.slice(0, 300),
      );
      await stand.api('/project-runner/stop', { method: 'POST', body: { path: dirs.app } });
      // Стенд удаляет свой каталог сразу после сценария: процесс цели должен его отпустить.
      for (let i = 0; i < 20; i += 1) {
        const runs = (await stand.api('/project-runner')).body;
        const own = runs.find((item) => item.projectPath.toLowerCase() === dirs.app.toLowerCase());
        if (!own || own.status === 'stopped') break;
        await wait(250);
      }
      await wait(1000);
    } finally {
      if (dockerUp) docker(['compose', '-p', COMPOSE_NAME, 'down', '-t', '0', '--remove-orphans']);
    }
  },
);
