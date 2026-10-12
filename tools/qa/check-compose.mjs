/**
 * Окно «Окружение», вкладка «Сервисы» — живой стенд, настоящий docker, настоящий UI.
 *
 * Одноразовая панель (`throwaway-stand.mjs`) и одноразовый стек Compose в
 * `docker/compose.yaml` демо-проекта: `db` (node-сервер с проверкой здоровья,
 * портом и именованным томом), `api` (зависит от db) и `job` (выходит с кодом 3).
 * Имя проекта compose уникально на прогон, у всего метка `claude.ephemeral`, и
 * в конце стек сносится `down -v` при любом исходе. Что проверяется:
 *
 * - API: файл найден в docker/, сервисы в порядке подъёма, тома из файла;
 *   проект без Compose — «нет файла»; файл с ошибкой — ответ docker дословно;
 * - негативы API: чужой каталог — 403 со своим кодом, `down -v` без
 *   подтверждения — 400, неизвестный сервис — 400, второе действие поверх
 *   идущего — 409;
 * - UI: кнопка «Окружение» в ряду проекта открывает окно; «Поднять всё»
 *   поднимает стек, фокус не теряется, ход виден в панели действия; состояния:
 *   «Работает, здоров», «Упал, код 3», «Работает»; порт — ссылка, и по ней
 *   отвечает сервис;
 * - остановка сервиса строкой — «Остановлен», а не «Упал, код 137»;
 * - «Удалить вместе с данными» переспрашивает, называет том, и после
 *   подтверждения у docker не остаётся ни контейнеров, ни томов стека;
 * - UI негатив: проект без Compose объясняет, где искали файл.
 *
 * Не проверяется вживую: «Docker не установлен» и «Docker не запущен» — демон
 * машины останавливать нельзя; оба состояния покрыты `compose.test.ts`.
 *
 * Запуск: `node tools/qa/check-compose.mjs`. Нет docker или демон не отвечает —
 * выход 2 «не проверено». Снимки — в `.agent/screenshots/before-after/backend-compose/`.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chromium } from 'playwright';
import { NotChecked, REPO, freePort, runOnStand, wait } from './throwaway-stand.mjs';
import { seedChatTranscript } from './backend-fixtures.mjs';

const SHOTS = join(REPO, '.agent', 'screenshots', 'before-after', 'backend-compose');
mkdirSync(SHOTS, { recursive: true });

const docker = (args, cwd) =>
  spawnSync('docker', args, { cwd, encoding: 'utf8', windowsHide: true, timeout: 120_000 });

const COMPOSE_NAME = `agentdeck-qa-${randomBytes(3).toString('hex')}`;
let dirs;
let port;

function put(dir, file, text) {
  mkdirSync(join(dir, ...file.split('/').slice(0, -1)), { recursive: true });
  writeFileSync(join(dir, file), text, 'utf8');
}

function seedProjects(root) {
  const stack = join(root, 'shop-stack');
  const none = join(root, 'plain-app');
  const broken = join(root, 'broken-stack');
  const stranger = join(root, 'outside', 'stranger-stack');
  put(
    stack,
    'docker/compose.yaml',
    `name: ${COMPOSE_NAME}
services:
  db:
    image: node:22-alpine
    command: ["node", "-e", "require('http').createServer((q,s)=>s.end('db-ok')).listen(3000)"]
    ports: ["127.0.0.1:${port}:3000"]
    volumes: ["data:/data"]
    labels: [claude.ephemeral=1]
    healthcheck:
      test: ["CMD", "wget", "-qO-", "http://127.0.0.1:3000"]
      interval: 1s
      retries: 20
  api:
    image: alpine
    command: ["sleep", "3600"]
    depends_on: [db]
    labels: [claude.ephemeral=1]
  job:
    image: alpine
    command: ["sh", "-c", "exit 3"]
    labels: [claude.ephemeral=1]
volumes:
  data:
    labels: [claude.ephemeral=1]
`,
  );
  put(stack, 'README.md', '# shop\n');
  put(none, 'package.json', '{"name":"plain-app"}\n');
  put(broken, 'compose.yaml', 'services:\n  web:\n    image: alpine\n    bogus_key: 1\n');
  put(stranger, 'compose.yaml', 'services:\n  web:\n    image: alpine\n');
  return { stack, none, broken, stranger };
}

async function closeKeyGate(page) {
  const close = page.getByRole('button', { name: 'Закрыть', exact: true });
  try {
    await close.first().waitFor({ timeout: 6000 });
    await close.first().click();
  } catch {
    // Окна не было — CLI на стенде нашёлся.
  }
}

/** Вкладка проекта в чате → «Окружение» → открытое окно. */
async function openEnvironment(stand, browser, projectName) {
  const page = await stand.newPage(browser, { width: 1440, height: 950 });
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
  // Окно въезжает с анимацией — снимок посреди неё показал бы полупрозрачный чат.
  await wait(500);
  return { page, dialog };
}

/** Строка сервиса в таблице окна. */
const row = (dialog, name) =>
  dialog
    .getByRole('row')
    .filter({ has: dialog.page().getByRole('rowheader', { name: new RegExp(`^${name}`) }) });

async function waitFor(fn, timeoutMs, stepMs = 500) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > until) return value;
    await wait(stepMs);
  }
}

const info = (stand, path) => stand.api(`/compose?path=${encodeURIComponent(path)}`);
const act = (stand, body) => stand.api('/compose/action', { method: 'POST', body });

/**
 * Дождаться конца действия `action` над стеком; вернуть итог. Действие названо
 * явно: сразу после клика в ответе ещё прошлое, уже законченное действие, и
 * «закончилось» без имени засчитало бы его.
 */
async function settle(stand, path, action, timeoutMs = 180_000) {
  return waitFor(
    async () => {
      const res = await info(stand, path);
      const job = res.body.job;
      return job && job.action === action && job.status !== 'running' ? res.body : undefined;
    },
    timeoutMs,
    1000,
  );
}

const probe = docker(['info', '--format', '{{.ServerVersion}}']);
if (probe.error || probe.status !== 0) {
  console.log('Не проверено: docker не установлен или не запущен');
  process.exit(2);
}

port = await freePort();

await runOnStand(
  {
    label: 'compose',
    seed: ({ root, cfg }) => {
      dirs = seedProjects(join(root, 'demo'));
      for (const path of [dirs.stack, dirs.none, dirs.broken]) seedChatTranscript(cfg, path);
    },
  },
  async (stand, check) => {
    for (const [name, path] of [
      ['shop-stack', dirs.stack],
      ['plain-app', dirs.none],
      ['broken-stack', dirs.broken],
    ]) {
      const res = await stand.api('/projects', { method: 'POST', body: { path, name } });
      if (res.status >= 300) throw new NotChecked(`проект ${name} не добавился: ${res.text}`);
    }

    const browser = await chromium.launch();
    try {
      /* ── API: чтение ───────────────────────────────────────────────── */
      const first = (await info(stand, dirs.stack)).body;
      check('файл найден в docker/', first.file === 'docker/compose.yaml', JSON.stringify(first));
      check('docker готов', first.docker === 'ok', first.docker);
      check('имя проекта compose из файла', first.projectName === COMPOSE_NAME, first.projectName);
      check(
        'сервисы в порядке подъёма: db и job раньше api',
        first.services?.map((s) => s.name).join(',') === 'db,job,api',
        JSON.stringify(first.services?.map((s) => s.name)),
      );
      check(
        'до подъёма все «не созданы»',
        first.services?.every((s) => s.state === 'absent'),
        JSON.stringify(first.services?.map((s) => s.state)),
      );
      check(
        'том из файла назван',
        first.volumes?.join(',') === 'data',
        JSON.stringify(first.volumes),
      );

      const none = (await info(stand, dirs.none)).body;
      check(
        'проект без Compose — файла нет',
        none.file === undefined && none.services.length === 0,
      );
      const broken = (await info(stand, dirs.broken)).body;
      check(
        'файл с ошибкой — ответ docker дословно',
        typeof broken.configError === 'string' && broken.configError.includes('bogus_key'),
        broken.configError,
      );

      /* ── API: негативы ─────────────────────────────────────────────── */
      const outside = await act(stand, { path: dirs.stranger, action: 'up' });
      check(
        'чужой каталог — 403 compose-project-unregistered',
        outside.status === 403 && outside.body.code === 'compose-project-unregistered',
        outside.text,
      );
      const noConfirm = await act(stand, { path: dirs.stack, action: 'down-volumes' });
      check(
        'down -v без подтверждения — 400 compose-confirm-required',
        noConfirm.status === 400 && noConfirm.body.code === 'compose-confirm-required',
        noConfirm.text,
      );
      const unknown = await act(stand, { path: dirs.stack, action: 'up', service: 'redis' });
      check(
        'неизвестный сервис — 400 compose-service-unknown',
        unknown.status === 400 && unknown.body.code === 'compose-service-unknown',
        unknown.text,
      );

      /* ── UI: поднять стек ──────────────────────────────────────────── */
      const { page, dialog } = await openEnvironment(stand, browser, 'shop-stack');
      await dialog.getByRole('table').waitFor({ timeout: 20_000 });
      check(
        'окно: три строки «Не создан»',
        (await dialog.getByText('Не создан', { exact: true }).count()) === 3,
      );
      await page.screenshot({ path: join(SHOTS, 'services-absent_AFTER.png') });

      await dialog.getByRole('button', { name: 'Поднять всё' }).click();
      const focusInside = await page.evaluate(() => {
        const active = document.activeElement;
        return Boolean(active && active !== document.body && active.closest('[role="dialog"]'));
      });
      check('фокус остался в окне, когда кнопки погасли', focusInside);
      const status = dialog.getByRole('status').filter({ hasText: /поднять всё/ });
      check(
        'ход действия виден',
        Boolean(await waitFor(async () => (await status.count()) > 0, 10_000)),
      );

      // Второе действие поверх идущего — сервер отказывает, пока первое не кончилось.
      // Вторым шлём тот же `up`, не `down`: успей первый закончиться, принятый `down`
      // сносил стек, и весь остаток сценария краснел на пустом месте (прогон 12.10).
      // Состояние первого читаем ДО запроса — после него `running` мог быть уже чужим.
      const firstJob = (await info(stand, dirs.stack)).body.job;
      const busy = await act(stand, { path: dirs.stack, action: 'up' });
      check(
        'второе действие поверх идущего — 409 compose-busy',
        (busy.status === 409 && busy.body.code === 'compose-busy') ||
          !(firstJob?.action === 'up' && firstJob.status === 'running'),
        `первое: ${firstJob?.action}/${firstJob?.status}; ответ: ${busy.text}`,
      );

      const upDone = await settle(stand, dirs.stack, 'up');
      check(
        '«Поднять всё» закончилось успешно',
        upDone?.job?.status === 'done',
        upDone?.job?.output,
      );

      const healthy = await waitFor(
        async () => (await row(dialog, 'db').getByText('Работает, здоров').count()) > 0,
        60_000,
      );
      check('db: «Работает, здоров»', Boolean(healthy));
      check(
        'job: «Упал, код 3»',
        Boolean(
          await waitFor(
            async () => (await row(dialog, 'job').getByText('Упал, код 3').count()) > 0,
            15_000,
          ),
        ),
      );
      check(
        'api: «Работает»',
        Boolean(
          await waitFor(
            async () =>
              (await row(dialog, 'api').getByText('Работает', { exact: true }).count()) > 0,
            15_000,
          ),
        ),
      );
      check(
        'панель действия: «Готово: поднять всё»',
        (await dialog.getByText('Готово: поднять всё').count()) > 0,
      );

      const link = row(dialog, 'db').getByRole('link', { name: new RegExp(`${port} → 3000`) });
      const href = await link.getAttribute('href').catch(() => null);
      check('порт db — ссылка на 127.0.0.1', href === `http://127.0.0.1:${port}`, String(href));
      const served = await fetch(`http://127.0.0.1:${port}`)
        .then((r) => r.text())
        .catch((e) => String(e));
      check('по ссылке отвечает сервис', served === 'db-ok', served);
      await page.screenshot({ path: join(SHOTS, 'services-running_AFTER.png') });

      /* ── UI: остановить сервис строкой ─────────────────────────────── */
      await row(dialog, 'db').getByRole('button', { name: 'Остановить db' }).click();
      const stopped = await settle(stand, dirs.stack, 'stop', 60_000);
      check('остановка db закончилась', stopped?.job?.status === 'done', stopped?.job?.output);
      const dbStopped = await waitFor(
        async () => (await row(dialog, 'db').getByText('Остановлен', { exact: true }).count()) > 0,
        15_000,
      );
      const dbState = stopped?.services?.find((s) => s.name === 'db');
      check(
        'db после остановки — «Остановлен», не «Упал»',
        Boolean(dbStopped) && (await row(dialog, 'db').getByText(/Упал/).count()) === 0,
        JSON.stringify(dbState),
      );

      /* ── UI: удалить вместе с данными ──────────────────────────────── */
      await dialog.getByRole('button', { name: 'Удалить вместе с данными' }).click();
      const confirm = page.getByRole('dialog', { name: 'Удалить контейнеры и тома?' });
      await confirm.waitFor({ timeout: 10_000 });
      check('подтверждение называет том', (await confirm.getByText(/data/).count()) > 0);
      await page.screenshot({ path: join(SHOTS, 'remove-volumes-confirm_AFTER.png') });
      await confirm.getByRole('button', { name: 'Удалить с данными' }).click();
      const removed = await settle(stand, dirs.stack, 'down-volumes', 120_000);
      check('down -v закончился', removed?.job?.status === 'done', removed?.job?.output);
      const leftContainers = docker([
        'ps',
        '-a',
        '-q',
        '--filter',
        `label=com.docker.compose.project=${COMPOSE_NAME}`,
      ]).stdout.trim();
      const leftVolumes = docker([
        'volume',
        'ls',
        '-q',
        '--filter',
        `label=com.docker.compose.project=${COMPOSE_NAME}`,
      ]).stdout.trim();
      check('у docker не осталось контейнеров стека', leftContainers === '', leftContainers);
      check('у docker не осталось томов стека', leftVolumes === '', leftVolumes);
      await page.close();

      /* ── UI негатив: проекта без Compose ───────────────────────────── */
      const plain = await openEnvironment(stand, browser, 'plain-app');
      const explained = await plain.dialog
        .getByText('В проекте нет Docker Compose')
        .waitFor({ timeout: 15_000 })
        .then(() => true)
        .catch(() => false);
      check('без Compose: окно объясняет, чего нет', explained);
      check(
        'без Compose: названы места поиска',
        (await plain.dialog.getByText(/docker\/, deploy\/, \.docker\//).count()) > 0,
      );
      await plain.page.screenshot({ path: join(SHOTS, 'no-compose_AFTER.png') });
      await plain.page.close();

      /* ── UI негатив: файл с ошибкой ────────────────────────────────── */
      const bad = await openEnvironment(stand, browser, 'broken-stack');
      const alert = bad.dialog.getByRole('alert');
      const shown = await alert
        .filter({ hasText: 'bogus_key' })
        .waitFor({ timeout: 15_000 })
        .then(() => true)
        .catch(() => false);
      check('файл с ошибкой: ответ docker в окне', shown);
      check(
        'файл с ошибкой: кнопок подъёма нет',
        (await bad.dialog.getByRole('button', { name: 'Поднять всё' }).count()) === 0,
      );
      await bad.page.screenshot({ path: join(SHOTS, 'config-error_AFTER.png') });
      await bad.page.close();
    } finally {
      await browser.close();
      // Стек сносится при любом исходе: одноразовый — значит, ничего после себя.
      docker(
        ['compose', '-p', COMPOSE_NAME, 'down', '-v', '--remove-orphans'],
        join(dirs.stack, 'docker'),
      );
    }
  },
);
