/**
 * Запуск бэкенд-проектов из панели — живой стенд, настоящий сервер, настоящий UI.
 *
 * Одноразовая панель (`throwaway-stand.mjs`) и демо-проекты из
 * `backend-fixtures.mjs`: Go-модуль с двумя программами в cmd/, FastAPI на uv,
 * Django, Spring Boot на Gradle и скрипт на чистом Python. Что проверяется:
 *
 * - API «что запускать» узнаёт стек каждого проекта, называет команду, файлы,
 *   по которым она угадана, и все найденные варианты;
 * - у Go-модуля программы из cmd/ — отдельные цели, их команда запускается из
 *   корня модуля (`go run ./cmd/api`), а не из подпапки;
 * - отсутствующий инструмент назван ДО запуска (цель с ним не запускаемая);
 * - Go-сервис запускается по-настоящему и адрес читается из вывода без схемы
 *   (`listening on :PORT`) — только если Go стоит на машине;
 * - Python-скрипт запускается по-настоящему, вывод не застревает в буфере;
 * - «Запустить всё» поднимает отмеченные цели одним запросом, «Остановить всё»
 *   гасит все цели проекта;
 * - негатив: отметка цели вне проекта отказана с понятной причиной;
 * - UI: поповер «Dev-сервер» показывает бейдж стека и файлы-доказательства,
 *   галочки набора, «Остановить всё»; кнопка ряда поднимает набор без поповера;
 *   выбор из найденных команд сохраняется и снимается «Вернуть автовыбор»;
 * - UI негатив: цель без программы (`task`) — причина названа, запуск заблокирован.
 *
 * Запуск: `node tools/qa/check-backend-runner.mjs`. `--shots <TAG>` — только
 * снимки поповера в `.agent/screenshots/before-after/backend-runner/` (так
 * снимается «до» на старом коде).
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { chromium } from 'playwright';
import { REPO, runOnStand, wait } from './throwaway-stand.mjs';
import { seedBackendProjects, seedChatTranscript } from './backend-fixtures.mjs';

const argv = process.argv.slice(2);
const shotsTag = argv.includes('--shots') ? argv[argv.indexOf('--shots') + 1] : undefined;
const SHOTS = join(REPO, '.agent', 'screenshots', 'before-after', 'backend-runner');
if (shotsTag) mkdirSync(SHOTS, { recursive: true });

const hasTool = (name) =>
  spawnSync(process.platform === 'win32' ? 'where' : 'which', [name], { stdio: 'ignore' })
    .status === 0;

let projects;

/**
 * На стенде нет `claude` в PATH — чат встречает окном «нужен доступ». Окно
 * модальное и прячет от ролей всё под собой, поэтому его закрывают первым.
 */
async function closeKeyGate(page) {
  const close = page.getByRole('button', { name: 'Закрыть', exact: true });
  try {
    await close.first().waitFor({ timeout: 6000 });
    await close.first().click();
  } catch {
    // Окна не было — CLI на стенде нашёлся.
  }
}

/** Открыть вкладку проекта в чате и поповер «Dev-сервер». */
async function openRunner(stand, browser, projectName, { width = 1440 } = {}) {
  const page = await stand.newPage(browser, { width, height: 950 });
  await page.goto(`${stand.webUrl}/chat`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('nav');
  await closeKeyGate(page);
  await page.getByRole('tab', { name: 'Проекты' }).first().click({ timeout: 15_000 });
  await page
    .getByRole('button', { name: new RegExp(projectName) })
    .first()
    .click({ timeout: 15_000 });
  const trigger = page.getByRole('button', { name: /^Dev-сервер$/ }).first();
  await trigger.waitFor({ timeout: 15_000 });
  await trigger.click();
  await page.getByRole('dialog', { name: /Настройки запуска|Dev-сервер/ }).waitFor();
  await wait(500);
  return page;
}

await runOnStand(
  {
    label: 'backend-runner',
    seed: ({ root, cfg }) => {
      projects = seedBackendProjects(join(root, 'demo'));
      for (const path of Object.values(projects)) seedChatTranscript(cfg, path);
    },
  },
  async (stand, check) => {
    for (const [key, path] of Object.entries(projects)) {
      const res = await stand.api('/projects', { method: 'POST', body: { path, name: key } });
      if (res.status >= 300) throw new Error(`проект ${key} не добавился: ${res.text}`);
    }

    const browser = await chromium.launch();
    try {
      if (shotsTag) {
        for (const [key, name] of [
          ['go', 'orders-go'],
          ['fastapi', 'billing-fastapi'],
          ['django', 'shop-django'],
        ]) {
          const page = await openRunner(stand, browser, name);
          await page.screenshot({ path: join(SHOTS, `${key}-popover_${shotsTag}.png`) });
          await page.close();
        }
        console.log(`Снимки: ${SHOTS}`);
        return;
      }

      const describe = async (path) =>
        (await stand.api(`/project-runner/describe?path=${encodeURIComponent(path)}`)).body;

      /* ── Go: цели из cmd/, команда из корня модуля ─────────────────── */
      const go = await describe(projects.go);
      const dirs = go.targets.map((target) => target.dir);
      check(
        'Go: программы из cmd/ — отдельные цели',
        dirs.includes('cmd/api') && dirs.includes('cmd/worker'),
        JSON.stringify(dirs),
      );
      const api = go.targets.find((target) => target.dir === 'cmd/api');
      check('Go: стек go у цели cmd/api', api?.stack === 'go', JSON.stringify(api));
      check(
        'Go: команда запускается из корня модуля',
        api?.candidates?.some((c) => c.command === 'go run ./cmd/api'),
        JSON.stringify(api?.candidates),
      );
      check(
        'Go: файлы-доказательства названы',
        api?.evidence?.includes('go.mod') && api?.evidence?.includes('cmd/api/main.go'),
        JSON.stringify(api?.evidence),
      );
      const root = go.targets.find((target) => target.dir === '');
      check(
        'Go: корень предлагает make run из Makefile',
        root?.candidates?.some((c) => c.command === 'make run' && c.stack === 'make'),
        JSON.stringify(root?.candidates),
      );

      /* ── Python: FastAPI на uv, Django ─────────────────────────────── */
      const fast = (await describe(projects.fastapi)).targets[0];
      check(
        'FastAPI: uv run uvicorn app.main:app',
        fast?.candidates?.[0]?.command === 'uv run uvicorn app.main:app --reload' &&
          fast?.framework === 'FastAPI',
        JSON.stringify(fast),
      );
      check(
        'FastAPI: доступность uv совпадает с машиной',
        fast?.candidates?.[0]?.available === hasTool('uv'),
        `uv на машине: ${hasTool('uv')}`,
      );
      const django = (await describe(projects.django)).targets[0];
      check(
        'Django: manage.py runserver среди вариантов, make run из Makefile — первым',
        django?.candidates?.some((c) => /manage\.py runserver$/.test(c.command)) &&
          django?.candidates?.[0]?.command === 'make run' &&
          django?.candidates?.some((c) => c.framework === 'Django'),
        JSON.stringify(django?.candidates),
      );

      /* ── Spring: обёртка Gradle, bootRun ───────────────────────────── */
      const spring = (await describe(projects.spring)).targets[0];
      check(
        'Spring Boot: bootRun через обёртку проекта',
        /gradlew(\.bat)? bootRun$/.test(spring?.command ?? '') &&
          spring?.framework === 'Spring Boot',
        JSON.stringify(spring),
      );
      check(
        'Spring Boot: обёртка в проекте — инструмент есть',
        spring?.missingTool === undefined,
        JSON.stringify(spring),
      );

      /* ── Отсутствующий инструмент ──────────────────────────────────── */
      const goTool = hasTool('go');
      check(
        'Go: отсутствие go названо до запуска (или go есть)',
        goTool ? api?.runnable === true : api?.runnable === false && api?.missingTool === 'go',
        JSON.stringify({ goTool, runnable: api?.runnable, missing: api?.missingTool }),
      );

      /* ── Живой запуск Python-скрипта ───────────────────────────────── */
      const plainStart = await stand.api('/project-runner/start', {
        method: 'POST',
        body: { path: projects.plain },
      });
      check('Python: запуск принят', plainStart.status === 200, plainStart.text);
      let plainRun;
      for (let i = 0; i < 40; i += 1) {
        const runs = (await stand.api('/project-runner')).body;
        plainRun = runs.find(
          (run) => run.projectPath.toLowerCase() === projects.plain.toLowerCase(),
        );
        if (plainRun?.status === 'running' || plainRun?.status === 'error') break;
        await wait(500);
      }
      check(
        'Python: адрес прочитан из вывода (буфер не держит строку)',
        plainRun?.status === 'running' && plainRun?.port === 18092,
        JSON.stringify(plainRun),
      );

      /* ── «Запустить всё» на Go-модуле ──────────────────────────────── */
      if (goTool) {
        for (const dir of ['cmd/api', 'cmd/worker']) {
          const res = await stand.api('/project-runner/group', {
            method: 'POST',
            body: { path: projects.go, dir, inGroup: true },
          });
          check(`Отметка ${dir} в общий запуск`, res.status === 200, res.text);
        }
        const all = await stand.api('/project-runner/start-all', {
          method: 'POST',
          body: { path: projects.go },
        });
        check(
          '«Запустить всё» принято',
          all.status === 200 && all.body?.started?.length === 2,
          all.text,
        );
        let goApi;
        for (let i = 0; i < 120; i += 1) {
          const runs = (await stand.api('/project-runner')).body;
          goApi = runs.find(
            (run) =>
              run.dir === 'cmd/api' && run.projectPath.toLowerCase() === projects.go.toLowerCase(),
          );
          if (goApi?.status === 'running' || goApi?.status === 'error') break;
          await wait(500);
        }
        check(
          'Go: адрес без схемы («listening on :18091») прочитан',
          goApi?.status === 'running' && goApi?.port === 18091,
          JSON.stringify(goApi),
        );
        if (goApi?.port) {
          const health = await fetch(`http://127.0.0.1:${goApi.port}/health`)
            .then((r) => r.json())
            .catch(() => null);
          check('Go: сервис отвечает по адресу', health?.status === 'ok', JSON.stringify(health));
        }
      } else {
        console.log('  — Go не установлен: живой запуск Go не проверялся');
      }

      /* ── Негатив: цель вне проекта ─────────────────────────────────── */
      const outside = await stand.api('/project-runner/group', {
        method: 'POST',
        body: { path: projects.go, dir: '../billing-fastapi', inGroup: true },
      });
      check('Отметка цели вне проекта отказана', outside.status === 400, outside.text);

      /* ── UI: Go — стек, файлы, набор, «Остановить всё», кнопка ряда ── */
      const runsOf = async (path) =>
        (await stand.api('/project-runner')).body.filter(
          (run) => run.projectPath.toLowerCase() === path.toLowerCase(),
        );
      const page = await openRunner(stand, browser, 'orders-go');
      const dialog = page.getByRole('dialog').first();
      check('UI: бейдж стека Go в поповере', /\bGo\b/.test(await dialog.innerText()));
      await dialog.locator('button[aria-expanded]', { hasText: 'cmd/api' }).first().click();
      const goText = await dialog.innerText();
      check(
        'UI: файлы, по которым найдена команда',
        goText.includes('Найдено по: go.mod, cmd/api/main.go'),
        goText.slice(0, 600),
      );
      check(
        'UI: источник списка — скан каталогов, не «один пакет»',
        goText.includes('Файла воркспейсов нет') && !goText.includes('Один пакет'),
        goText.slice(0, 300),
      );
      if (goTool) {
        const mark = dialog.getByRole('checkbox', { name: /В «Запустить всё»: .*api/ }).first();
        check('UI: галочка набора стоит у cmd/api', await mark.isChecked());
        mkdirSync(SHOTS, { recursive: true });
        await page.screenshot({ path: join(SHOTS, 'go-popover_AFTER.png') });

        await dialog.getByRole('button', { name: 'Остановить всё' }).click();
        let left = [];
        for (let i = 0; i < 40; i += 1) {
          left = await runsOf(projects.go);
          if (left.length === 0) break;
          await wait(250);
        }
        check(
          'UI: «Остановить всё» погасило цели проекта',
          left.length === 0,
          JSON.stringify(left),
        );

        // Кнопка запуска в ряду при отмеченном наборе поднимает его без поповера.
        await page.keyboard.press('Escape');
        const play = page.getByRole('button', { name: 'Запустить dev-сервер', exact: true });
        // Ряд узнаёт об остановке своим опросом (~2 с) — ждём его, а не гадаем.
        let title = '';
        for (let i = 0; i < 20; i += 1) {
          title = (await play.getAttribute('title')) ?? '';
          if (/Запустить набор:/.test(title)) break;
          await wait(250);
        }
        check(
          'UI: подсказка кнопки ряда называет набор',
          /Запустить набор:/.test(title ?? ''),
          title,
        );
        await play.click();
        let up = [];
        for (let i = 0; i < 120; i += 1) {
          up = await runsOf(projects.go);
          if (up.length === 2 && up.every((run) => run.status === 'running')) break;
          await wait(500);
        }
        check(
          'UI: кнопка ряда подняла весь набор',
          up.length === 2 && up.every((run) => run.status === 'running'),
          JSON.stringify(up.map((run) => [run.dir, run.status, run.port])),
        );
        check(
          'UI: поповер не открылся — запуск сразу',
          (await page.getByRole('dialog').count()) === 0,
          (
            await page
              .getByRole('dialog')
              .evaluateAll((list) =>
                list.map(
                  (el) => `${el.getAttribute('aria-label') ?? ''} ${el.textContent?.slice(0, 120)}`,
                ),
              )
          ).join(' | '),
        );
      }
      check('UI: без ошибок страницы (Go)', page.errors.length === 0, page.errors.join('\n'));
      await page.close();

      /* ── UI: FastAPI — один способ, выбирать не из чего ──────────── */
      const fastPage = await openRunner(stand, browser, 'billing-fastapi');
      check(
        'UI: у FastAPI один способ — списка выбора нет',
        (await fastPage.getByRole('dialog').first().getByRole('radio').count()) === 0,
      );
      await fastPage.screenshot({ path: join(SHOTS, 'fastapi-popover_AFTER.png') });
      await fastPage.close();

      /* ── UI: Django — выбор из найденных и возврат к автовыбору ───── */
      const djangoPage = await openRunner(stand, browser, 'shop-django');
      const djangoDialog = djangoPage.getByRole('dialog').first();
      const radios = djangoDialog.getByRole('radio');
      const count = await radios.count();
      check('UI: способы запуска Django показаны списком', count >= 2, `радио: ${count}`);
      await djangoPage.screenshot({ path: join(SHOTS, 'django-popover_AFTER.png') });
      if (count >= 2) {
        const second = (await describe(projects.django)).targets[0].candidates[1].command;
        await radios.nth(1).check();
        let chosen;
        for (let i = 0; i < 20; i += 1) {
          chosen = (await describe(projects.django)).targets[0];
          if (chosen.commandOverride === second) break;
          await wait(250);
        }
        check(
          'UI: выбранная команда сохранена и осталась находкой (стек python, не custom)',
          chosen?.commandOverride === second &&
            chosen?.stack === 'python' &&
            chosen?.framework === 'Django',
          JSON.stringify({ override: chosen?.commandOverride, stack: chosen?.stack, second }),
        );
        await djangoPage.screenshot({ path: join(SHOTS, 'django-picked_AFTER.png') });
        await djangoDialog.getByRole('button', { name: 'Вернуть автовыбор' }).click();
        for (let i = 0; i < 20; i += 1) {
          chosen = (await describe(projects.django)).targets[0];
          if (!chosen.commandOverride) break;
          await wait(250);
        }
        check(
          'UI: «Вернуть автовыбор» снял команду',
          !chosen?.commandOverride,
          JSON.stringify(chosen),
        );
      }
      check(
        'UI: без ошибок страницы (Django)',
        djangoPage.errors.length === 0,
        djangoPage.errors.join('\n'),
      );
      await djangoPage.close();

      /* ── UI негатив: программы нет — названа до запуска ────────────── */
      if (!hasTool('task')) {
        const taskPage = await openRunner(stand, browser, 'jobs-taskfile');
        const taskDialog = taskPage.getByRole('dialog').first();
        const taskText = await taskDialog.innerText();
        check(
          'UI: нет программы task — сказано до запуска',
          taskText.includes('Не найдена программа «task»'),
          taskText.slice(0, 400),
        );
        const rowPlay = taskDialog.getByRole('button', { name: /^Запустить: / }).first();
        check('UI: запуск такой цели заблокирован', await rowPlay.isDisabled());
        await taskPage.screenshot({ path: join(SHOTS, 'taskfile-missing-tool_AFTER.png') });
        await taskPage.close();
      } else {
        console.log('  — task установлен: негатив «нет программы» не проверялся');
      }

      const stopAll = await stand.api('/project-runner/stop-all', {
        method: 'POST',
        body: { path: projects.go },
      });
      check('«Остановить всё» через API принято', stopAll.status === 200, stopAll.text);
      await stand.api('/project-runner/stop', { method: 'POST', body: { path: projects.plain } });
    } finally {
      await browser.close();
    }
  },
);
