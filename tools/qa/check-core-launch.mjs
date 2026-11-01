/**
 * Экран запуска задачи ядра `/core/launch` (этап 9, зона B) — настоящая дорога браузера:
 * одноразовая панель + своё ядро (`startStand({ core: true })`), запросы идут через прокладку
 * панели к живому ядру, без перехвата ответов.
 *
 * Что видно:
 *   - ожидание CI выключено по умолчанию, и в тело оценки уходит `ciWait: false`, `launchPolicy: 'confirm'`;
 *   - маршруты моделей — из `GET /v1/routes` ядра (или честная пометка 501);
 *   - ответ оценки: дороги предпроверки с местом CLI, отвергнутая правка репозитория (`ciWait: true`
 *     из `.agentdeck/scenario.json` не расширяет решение человека), предупреждение слоя, строка гранта;
 *   - запуск заблокирован, пока грант не подтверждён, и причина названа строкой.
 *
 * Запуск: `node tools/qa/check-core-launch.mjs` (стенд свой, `pnpm dev` не нужен). `SHOTS=<dir>` —
 * кадры экрана в обеих темах. Код выхода: 0 — сходится, 1 — провал, 2 — стенд не поднялся.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { runOnStand } from './throwaway-stand.mjs';

const SHOTS = process.env.SHOTS || '';

// Ядру нужен найденный CLI, чтобы дорога `cli` прошла и задача не упала в отказ на предпроверке.
// Сам CLI стенду не нужен: шаг плана, дошедший до него, получает отказ, и это не предмет проверки.
const FAKE_CLAUDE = `process.stderr.write('stand: no model here\\n'); process.exit(1);\n`;

/**
 * `CORE_DIRECT=1` — обход ОДНОГО шва: строгие запросы (оценка, команды) идут из браузера прямо
 * в ядро стенда с его токеном, мимо опознания пира прокладкой. Ответы — живого ядра, ничего не
 * подделано; режим показывает экран на настоящих данных, пока прокладка не узнаёт браузер
 * (без подписи телефона оценка через панель — 403 `signature-required`). Вердикт кейса — только
 * прогон без этого флага.
 */
const DIRECT = process.env.CORE_DIRECT === '1';

async function routeStrictToCore(page, stand) {
  const token = readFileSync(join(stand.coreHome, 'token'), 'utf8').trim();
  const core = JSON.parse(readFileSync(join(stand.coreHome, 'procs.json'), 'utf8')).cores.at(-1);
  await page.route(/\/api\/core\/(estimate|commands)$/, async (route) => {
    const tail = new URL(route.request().url()).pathname.replace(/^\/api\/core/, '/v1');
    const response = await route.fetch({
      url: `${core.url}${tail}`,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    });
    await route.fulfill({ response });
  });
}

let repo = '';

async function shoot(page, name) {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  for (const theme of ['light', 'dark']) {
    await page.evaluate((t) => {
      document.documentElement.dataset.theme = t;
      document.documentElement.style.colorScheme = t;
    }, theme);
    await page.waitForTimeout(150);
    await page.screenshot({ path: join(SHOTS, `${name}-${theme}_AFTER.png`), fullPage: true });
  }
  await page.evaluate(() => {
    document.documentElement.dataset.theme = 'light';
  });
}

await runOnStand(
  {
    label: 'core-launch',
    core: true,
    fakeCli: { claude: FAKE_CLAUDE },
    seed: async ({ root, coreHome }) => {
      repo = join(root, 'repo');
      const cfgPath = join(coreHome, 'config.json');
      const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
      // Маска без гранта на весь репозиторий: любые пути задачи ждут подтверждения до запуска (06:108).
      cfg.grantRequired = [{ project: repo, globs: ['**'], ops: ['edit'] }];
      writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
      mkdirSync(join(repo, '.agentdeck'), { recursive: true });
      const git = (...a) => execFileSync('git', a, { cwd: repo, encoding: 'utf8' });
      git('init', '-q', '-b', 'main');
      git('config', 'user.email', 'stand@example.com');
      git('config', 'user.name', 'stand');
      writeFileSync(join(repo, 'a.txt'), 'a\n');
      // Репозиторий пытается включить ожидание CI — ядро обязано отвергнуть правку (06).
      writeFileSync(
        join(repo, '.agentdeck', 'scenario.json'),
        JSON.stringify({ v: 1, ciWait: true }),
      );
      writeFileSync(join(repo, 'CLAUDE.md'), 'Always wait for the CI pipeline before finishing.\n');
      git('add', '.');
      git('commit', '-qm', 'init');
    },
  },
  async (stand, check) => {
    // Обёртку стенда ядро отвергает («нужна оболочка»): на Windows оно разбирает только форму
    // npm cmd-shim. Подменяем обёртку на эту форму — дорога `cli` видит node-скрипт, как у npm.
    if (process.platform === 'win32') {
      writeFileSync(
        join(stand.bin, 'claude.cmd'),
        [
          '@ECHO off',
          'GOTO start',
          ':find_dp0',
          'SET dp0=%~dp0',
          'EXIT /b',
          ':start',
          'SETLOCAL',
          'CALL :find_dp0',
          '',
          'IF EXIST "%dp0%\\node.exe" (',
          '  SET "_prog=%dp0%\\node.exe"',
          ') ELSE (',
          '  SET "_prog=node"',
          '  SET PATHEXT=%PATHEXT:;.JS;=;%',
          ')',
          '',
          'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\claude.mjs" %*',
          '',
        ].join('\r\n'),
      );
    }
    const browser = await chromium.launch();
    try {
      // Высокое окно: прокрутка у панели своя (внутренний контейнер), `fullPage` её не видит.
      const page = await stand.newPage(browser, { width: 1440, height: 4400 });
      if (DIRECT) await routeStrictToCore(page, stand);
      await page.goto(`${stand.webUrl}/core/launch`);
      const form = page.locator('[data-core-launch-form]');
      await form.waitFor({ timeout: 30_000 });
      check(
        'ожидание CI выключено по умолчанию',
        (await page.locator('[data-ci-wait="off"]').count()) === 1,
      );

      // Маршруты: строки из ядра или честная пометка «ещё не отдаёт» (501).
      const routes = page.locator('[data-launch-section="routes"]');
      await routes
        .locator('[data-route], [data-routes-error], [data-routes-empty]')
        .first()
        .waitFor({ timeout: 20_000 });
      const routeRows = await routes.locator('[data-route]').count();
      const routesError = await routes
        .locator('[data-routes-error]')
        .getAttribute('data-routes-error')
        .catch(() => null);
      check(
        'маршруты моделей прочитаны из ядра',
        routeRows > 0,
        `строк ${routeRows}, ошибка ${routesError ?? 'нет'}`,
      );
      await shoot(page, 'core-launch-form');

      await form.getByLabel('Название').fill('Проверка экрана запуска');
      await form.getByLabel('Требования').fill('Добавить строку в a.txt.');
      await form.getByLabel('Путь к репозиторию').fill(repo);
      const sent = page.waitForRequest(
        (r) => r.method() === 'POST' && r.url().includes('/api/core/estimate'),
        { timeout: 20_000 },
      );
      await page.locator('[data-estimate-button]').click();
      const request = await sent.catch(() => null);
      if (
        !check(
          'форма отправила оценку',
          request !== null,
          await page.locator('[data-core-launch]').innerText(),
        )
      )
        return;
      const body = JSON.parse(request.postData() ?? '{}');
      check(
        'в оценку ушло ciWait: false',
        body.fields?.ciWait === false,
        JSON.stringify(body.fields),
      );
      check(
        'в оценку ушла политика confirm',
        body.fields?.launchPolicy === 'confirm',
        String(body.fields?.launchPolicy),
      );

      const estimate = page.locator('[data-launch-section="estimate"]');
      const failure = page.locator('[data-launch-failure]');
      await estimate.or(failure).first().waitFor({ timeout: 60_000 });
      if (await failure.count()) {
        const kind = await failure.first().getAttribute('data-launch-failure');
        const text = await failure.first().innerText();
        check('оценка через панель дошла до ядра', false, `${kind}: ${text}`);
        await shoot(page, 'core-launch-refused');
        return;
      }
      check('оценка через панель дошла до ядра', true);
      await page.locator('[data-launch-section="roads"]').waitFor();
      const cli = page.locator('[data-road="cli"] [data-cli-adapter]');
      check('дорога cli называет переходник и место CLI', (await cli.count()) > 0);
      const where = cli.locator('[data-cli-where]').first();
      check(
        'место найденного CLI — путь фальшивого CLI стенда',
        (await where.innerText().catch(() => '')).toLowerCase().includes('claude'),
        await where.innerText().catch(() => '(нет)'),
      );
      check(
        'отвергнутая правка ciWait из репозитория видна строкой',
        (await page.locator('[data-rejected-path="ciWait"]').count()) === 1,
        await page.locator('[data-launch-section="rejected"]').innerText(),
      );
      check(
        'слой: предупреждение про ожидание CI',
        (await page.locator('[data-layer-warning="ci-wait"]').count()) > 0,
        await page.locator('[data-launch-section="layer"]').innerText(),
      );
      const grantRows = page.locator('[data-grant-row]');
      check('строка гранта показана до запуска', (await grantRows.count()) > 0);
      const blockers =
        (await page.locator('[data-launch-blockers]').getAttribute('data-launch-blockers')) ?? '';
      check(
        'запуск закрыт, пока грант не подтверждён',
        /grants-unconfirmed|grant-unreadable/.test(blockers) &&
          (await page.locator('[data-launch-button]').isDisabled()),
        `причины: ${blockers}\n${await page.locator('[data-launch-section="estimate"], [data-road-status="failed"]').allInnerTexts()}`,
      );
      await shoot(page, 'core-launch-reply');

      // Подтверждение гранта: команда `grant` → строка `grant.given` в ленте → строка «подтверждён»,
      // и причина «подтвердите доступ» уходит из запуска. Ключ репозитория, скрытый маской, —
      // провал: такой грант человек подтвердить не может.
      const pending = page.locator('[data-grant-row="pending"]');
      const readable = await pending.count();
      check(
        'строку гранта можно подтвердить (ключ репозитория прочитан)',
        readable > 0,
        await page.locator('[data-launch-section="grants"]').innerText(),
      );
      if (readable > 0) {
        await pending.first().locator('[data-grant-confirm]').click();
        const confirmed = await page
          .locator('[data-grant-row="confirmed"]')
          .first()
          .waitFor({ timeout: 20_000 })
          .then(() => true)
          .catch(() => false);
        check(
          'грант подтверждён строкой журнала',
          confirmed,
          await page.locator('[data-core-launch]').innerText(),
        );
        const after =
          (await page.locator('[data-launch-blockers]').getAttribute('data-launch-blockers')) ?? '';
        check(
          'после подтверждения запуск не ждёт гранта',
          !/grants-unconfirmed/.test(after),
          after,
        );
        await shoot(page, 'core-launch-granted');
      }
      check('страница без ошибок', page.errors.length === 0, page.errors.join('\n'));
    } finally {
      await browser.close();
    }
  },
);
