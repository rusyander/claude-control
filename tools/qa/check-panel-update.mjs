/**
 * Обновление панели из «Что нового» на живом стенде (`pnpm dev`, :8888).
 *
 * Первый сценарий идёт по НАСТОЯЩЕМУ `/api/panel-update` — сервер делает fetch
 * этого репозитория; остальные подменяют его ответ (`page.route`), потому что
 * «вышли новые коммиты», «свои правки», «ветка разошлась» нельзя устроить в
 * рабочем клоне человека, не тронув его. Подмена только у границы: страница,
 * карточка, боковая панель, диалог и тосты настоящие. Перемотку настоящим git
 * проверяет `apps/server/src/domains/panel-update/panel-update.git.test.ts`.
 * POST не уходит на сервер ни в одном сценарии: проверка ничего не обновляет.
 *
 * Строки таблицы — то, что проверено; ненулевой код выхода — любое расхождение.
 * Снимки кладутся в `.agent/screenshots/panel-update/`.
 *
 * Запуск: node tools/qa/check-panel-update.mjs   (браузеры: pnpm qa:setup)
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { bypassOnboarding } from './bypass-onboarding.mjs';

const BASE = process.env.APP_URL ?? 'http://localhost:8888';
const SHOTS = join('.agent', 'screenshots', 'panel-update');
mkdirSync(SHOTS, { recursive: true });

const rows = [];
const check = (name, ok, detail = '') => {
  rows.push({ name, ok: Boolean(ok), detail: String(detail) });
};

const status = (over = {}) => ({
  state: 'behind',
  branch: 'main',
  upstream: 'origin/main',
  behind: 2,
  ahead: 0,
  incoming: [
    { hash: 'b'.repeat(40), date: '2026-10-13T10:00:00+05:00', subject: 'chore: зависимости' },
    { hash: 'a'.repeat(40), date: '2026-10-13T09:00:00+05:00', subject: 'feat: кнопка' },
  ],
  entries: [
    {
      id: '2026-10-13-update',
      title: { ru: 'Кнопка обновления панели', en: 'Panel update button' },
    },
  ],
  dirty: [],
  lockChanged: true,
  fetchedAt: '2026-10-13T07:00:00.000Z',
  ...over,
});

const commits = (n) =>
  Array.from({ length: n }, (_, i) => ({
    hash: `${i}`.padStart(40, 'c'),
    date: '2026-10-13T09:00:00+05:00',
    subject: `fix: правка номер ${i + 1}`,
  }));

/** `get` — ответ GET (null — настоящий сервер), `post` — ответ POST. */
async function open(browser, { get = null, post, colorScheme = 'light' } = {}) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, colorScheme });
  const page = await context.newPage();
  await bypassOnboarding(page);
  const seen = { get: [], post: 0 };
  await page.route(/\/api\/panel-update(\?.*)?$/, async (route) => {
    const request = route.request();
    if (request.method() === 'POST') {
      seen.post += 1;
      // Ни одна строка проверки не должна обновить настоящий клон.
      return route.fulfill({
        json: post ?? { ok: false, error: 'busy', watched: true, status: get },
      });
    }
    seen.get.push(request.url());
    if (get === null) return route.continue();
    return route.fulfill({ json: typeof get === 'function' ? get() : get });
  });
  return { context, page, seen };
}

const card = (page) => page.locator('[data-panel-update]');
const dot = (page) => page.locator('[data-nav-dot="history"]');
const goto = async (page) => {
  await page.goto(`${BASE}/history?tab=changelog`, { waitUntil: 'domcontentloaded' });
  await card(page).first().waitFor({ timeout: 20000 });
};

const browser = await chromium.launch();
try {
  // ── 1. Настоящий сервер: репозиторий этой панели ──────────────────────────
  {
    const { context, page, seen } = await open(browser);
    await goto(page);
    const state = await card(page).getAttribute('data-panel-update');
    check('настоящий ответ: состояние на карточке', !!state, state);
    if (state === 'current') {
      check(
        'последняя версия — тихая строка, точки нет',
        (await page.getByText('Установлена последняя версия').count()) === 1 &&
          (await dot(page).count()) === 0,
      );
      const before = seen.get.length;
      await page.locator('[data-panel-update-check]').click();
      await page.waitForResponse((r) => r.url().includes('/api/panel-update?refresh=1'), {
        timeout: 70000,
      });
      check(
        '«Проверить сейчас» — запрос с refresh=1 к настоящему серверу',
        seen.get.slice(before).some((url) => url.includes('refresh=1')),
      );
    } else {
      check('состояние не «последняя» — сценарий 1 сверяет только наличие', true, state);
    }
    await context.close();
  }

  // ── 2. Вышли коммиты с описанием и новым lock-файлом ──────────────────────
  {
    const { context, page } = await open(browser, { get: status() });
    await goto(page);
    check(
      'карточка «вышла новая версия»',
      (await card(page).getAttribute('data-panel-update')) === 'behind',
    );
    check(
      'число и ветка',
      (await card(page).getByText('2 новых коммита на origin/main').count()) === 1,
    );
    check(
      'описание из входящих',
      (await card(page).getByText('Кнопка обновления панели').count()) === 1,
    );
    check(
      'темы коммитов не дублируют описание',
      (await card(page).getByText('feat: кнопка').count()) === 0,
    );
    check(
      'новый lock-файл назван',
      (await card(page)
        .getByText(/pnpm install/)
        .count()) >= 1,
    );
    check('зелёная точка у «Истории изменений»', (await dot(page).count()) === 1);
    check('«Обновить» доступна', await page.locator('[data-panel-update-apply]').isEnabled());
    await page.screenshot({ path: join(SHOTS, 'behind-light.png') });
    await dot(page).scrollIntoViewIfNeeded();
    await page
      .locator('nav')
      .first()
      .screenshot({ path: join(SHOTS, 'sidebar-dot.png') });
    // Точка на значке — видна и в свёрнутой панели.
    await page.locator('[data-sidebar-toggle]').click();
    await page.waitForTimeout(500);
    check('точка видна в свёрнутой панели', await dot(page).isVisible());
    await page.screenshot({ path: join(SHOTS, 'behind-collapsed.png') });
    await context.close();
  }

  // ── 3. Обновление: диалог, итог, точка гаснет ─────────────────────────────
  {
    let current = status();
    const done = {
      ok: true,
      from: 'a'.repeat(40),
      to: '1234567890abcdef'.padEnd(40, '0'),
      installed: true,
      watched: true,
      status: status({
        state: 'current',
        behind: 0,
        incoming: [],
        entries: [],
        lockChanged: false,
      }),
    };
    const { context, page, seen } = await open(browser, { get: () => current, post: done });
    await goto(page);
    await page.locator('[data-panel-update-apply]').click();
    const dialog = page.getByRole('dialog');
    await dialog.waitFor({ timeout: 5000 });
    check(
      'подтверждение называет перемотку и ветку',
      (await dialog.getByText(/origin\/main/).count()) === 1,
    );
    current = done.status;
    await dialog.getByRole('button', { name: 'Обновить' }).click();
    await page.locator('[data-panel-update-done]').waitFor({ timeout: 10000 });
    check('POST отправлен один раз', seen.post === 1, seen.post);
    check(
      'итог: до какого коммита',
      (await page.getByText('Панель обновлена до 12345678').count()) >= 1,
    );
    check(
      'итог: зависимости установлены',
      (await page.getByText('Зависимости установлены.').count()) === 1,
    );
    check('итог: сервер подхватит сам', (await page.getByText(/интерфейс — сразу/).count()) === 1);
    check('точка погасла', (await dot(page).count()) === 0);
    await page.screenshot({ path: join(SHOTS, 'done-light.png') });
    await context.close();
  }

  // ── 4. Свои правки: кнопка закрыта, файлы названы (отрицательный) ─────────
  {
    const { context, page, seen } = await open(browser, {
      get: status({ dirty: ['apps/web/src/main.tsx', 'README.md'] }),
    });
    await goto(page);
    const apply = page.locator('[data-panel-update-apply]');
    check('с правками «Обновить» закрыта', await apply.isDisabled());
    await apply.click({ force: true });
    await page.waitForTimeout(300);
    check(
      'щелчок по закрытой не открыл диалог и не отправил POST',
      (await page.getByRole('dialog').count()) === 0 && seen.post === 0,
    );
    check(
      'файлы правок названы',
      (await page
        .locator('[data-panel-update-dirty]')
        .getByText('apps/web/src/main.tsx')
        .count()) === 1,
    );
    await page.screenshot({ path: join(SHOTS, 'dirty-light.png') });
    await context.close();
  }

  // ── 5. Без описаний: темы коммитов, остаток числом ────────────────────────
  {
    const { context, page } = await open(browser, {
      get: status({ behind: 7, incoming: commits(7), entries: [], lockChanged: false }),
    });
    await goto(page);
    check(
      'пять тем коммитов',
      (await card(page)
        .getByText(/fix: правка номер/)
        .count()) === 5,
    );
    check('остаток назван', (await card(page).getByText('и ещё 2 коммита').count()) === 1);
    check(
      'без lock-файла про pnpm ни слова',
      (await card(page)
        .getByText(/pnpm install/)
        .count()) === 0,
    );
    await context.close();
  }

  // ── 6. Ветка разошлась: объяснение без кнопки ─────────────────────────────
  {
    const { context, page } = await open(browser, { get: status({ state: 'diverged', ahead: 3 }) });
    await goto(page);
    check(
      'разошлась — своё состояние',
      (await card(page).getAttribute('data-panel-update')) === 'diverged',
    );
    check(
      'числа своих и новых коммитов',
      (await page.getByText(/Своих коммитов здесь: 3, новых на origin\/main: 2/).count()) === 1,
    );
    check('кнопки «Обновить» нет', (await page.locator('[data-panel-update-apply]').count()) === 0);
    check('точки нет — обновить кнопкой нельзя', (await dot(page).count()) === 0);
    await context.close();
  }

  // ── 7. Git отказал при перемотке; fetch не прошёл ─────────────────────────
  {
    const failed = {
      ok: false,
      error: 'pull-failed',
      detail: 'error: The following untracked working tree files would be overwritten by merge',
      watched: true,
      status: status({ fetchError: 'fatal: unable to access remote' }),
    };
    const { context, page } = await open(browser, {
      get: status({ fetchError: 'fatal: unable to access remote' }),
      post: failed,
    });
    await goto(page);
    check(
      'ошибка fetch названа',
      (await page.locator('[data-panel-update-fetch-error]').count()) === 1,
    );
    await page.locator('[data-panel-update-apply]').click();
    await page.getByRole('dialog').getByRole('button', { name: 'Обновить' }).click();
    await page
      .getByText(/would be overwritten/)
      .first()
      .waitFor({ timeout: 10000 });
    check(
      'отказ git показан как есть',
      (await page.getByText(/would be overwritten/).count()) >= 1,
    );
    check('итога «обновлено» нет', (await page.locator('[data-panel-update-done]').count()) === 0);
    await context.close();
  }

  // ── 8. Тёмная тема ────────────────────────────────────────────────────────
  {
    const { context, page } = await open(browser, { get: status(), colorScheme: 'dark' });
    await goto(page);
    await page.screenshot({ path: join(SHOTS, 'behind-dark.png') });
    check('снимок тёмной темы', true, 'behind-dark.png');
    await context.close();
  }
} catch (error) {
  check('сценарий дошёл до конца', false, String(error.message).split('\n')[0]);
} finally {
  await browser.close();
}

const width = Math.max(...rows.map((r) => r.name.length));
for (const r of rows) {
  console.log(`${r.ok ? 'OK  ' : 'FAIL'}  ${r.name.padEnd(width)}  ${r.detail}`);
}
const failedRows = rows.filter((r) => !r.ok);
console.log(
  `\n${rows.length - failedRows.length}/${rows.length} строк сошлись, расхождений: ${failedRows.length}`,
);
process.exit(failedRows.length ? 1 : 0);
