/**
 * Общая обвязка проверок страницы групп: страница с подменой API групп,
 * журнал ошибок и запросов, строка «ок / ПЛОХО» и итог. Сценарий проверки —
 * только шаги и ожидания; ловушки стенда (5xx неподменённого адреса во время
 * перезагрузки дев-сервера) чинятся здесь, а не в каждой проверке.
 */
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { bypassOnboarding } from './bypass-onboarding.mjs';
import { STUBBED, installGroupStubs, makeGroupState, openGroup } from './group-stubs.mjs';

/**
 * Адрес фронта. Без `APP_URL` проверка поднимает СВОЙ фронт без слежения за
 * файлами (`VITE_NO_RELOAD=1`) над тем же API: общий стенд :8888 перезагружает
 * страницу на каждую чужую правку, и прогоны падали посреди сценария (S-502,
 * 27.09: sources/builder/knobs умерли на первом запуске). API групп подменён,
 * остальное — GET к API стенда; его 5xx в миг перезапуска журнал отмечает, а не
 * считает ошибкой.
 */
export let BASE = process.env.APP_URL ?? '';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const pause = (ms) => new Promise((done) => setTimeout(done, ms));

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

/** Ответ, а не секунды: адрес отдал хоть что-то, кроме 5xx шлюза. */
async function answers(url, seconds) {
  for (let i = 0; i < seconds * 2; i += 1) {
    const status = await fetch(url)
      .then((res) => res.status)
      .catch(() => 0);
    if (status > 0 && status < 500) return true;
    await pause(500);
  }
  return false;
}

/** Свой замороженный фронт; `stop` гасит ровно запущенный процесс. */
async function ownFront() {
  const port = await freePort();
  const child = spawn(
    process.execPath,
    [
      join('node_modules', 'vite', 'bin', 'vite.js'),
      '--port',
      String(port),
      '--strictPort',
      '--host',
      '127.0.0.1',
    ],
    {
      cwd: join(ROOT, 'apps', 'web'),
      env: { ...process.env, BROWSER: 'none', VITE_NO_RELOAD: '1' },
      stdio: 'ignore',
      shell: false,
    },
  );
  const url = `http://127.0.0.1:${port}`;
  const stop = () => {
    if (child.exitCode === null) child.kill();
  };
  if (!(await answers(url, 120))) {
    stop();
    throw new Error(`свой фронт на ${url} не поднялся`);
  }
  console.log(`инфо свой фронт ${url} (pid ${child.pid}), API стенда`);
  return { url, stop };
}

/** Имена групп подмены, которые проверки открывают. */
export const PAIR = 'Порядок задачи (общий)';
export const MANUAL = 'Фронтенд-работа';
export const SITE = 'Документация сайта';

export const visible = (locator) => locator.isVisible().catch(() => false);

/** Список строк порядка работы внутри окна группы. */
export const pathList = (scope) => scope.getByRole('list', { name: 'Шаги порядка работы' });

/**
 * Номера строк порядка работы по порядку экрана. Нумеруются только шаги:
 * стадии — разделители, «+» — места; шаги скилла лежат во вложенном списке блока.
 */
export const rowNumbers = (list) =>
  list.evaluate((node) =>
    [...node.querySelectorAll('li > span[aria-hidden="true"][class*="number"]')].map(
      (item) => item.textContent ?? '',
    ),
  );

/** Названия шагов по порядку экрана — текст кнопки строки (не ручки, не «+»). */
export const rowTitles = (list) =>
  list
    .locator('li button[aria-describedby]:not([aria-label])')
    .evaluateAll((items) => items.map((item) => item.textContent ?? ''));

/** Последний список своих шагов, отправленный PUT для группы `id`. */
export const lastSteps = (state, id) =>
  state.calls.filter((call) => call.path === `/groups/${id}/path/steps`).at(-1)?.body?.steps;

export async function startRun(shotsDir) {
  mkdirSync(shotsDir, { recursive: true });
  const front = process.env.APP_URL ? undefined : await ownFront();
  if (front) BASE = front.url;
  // API стенда мог уйти в перезапуск — ждём ответа, а не падаем первым же 502.
  if (!(await answers(`${BASE}/api/location`, 90))) {
    front?.stop();
    throw new Error(`API за ${BASE} не отвечает 90 с`);
  }
  const browser = await chromium.launch();
  let bad = 0;

  const check = (ok, expected, actual = '') => {
    console.log(`${ok ? 'ок  ' : 'ПЛОХО'} ${expected}${actual ? ` — видно: ${actual}` : ''}`);
    if (!ok) bad += 1;
  };

  /**
   * Страница групп с подменой. `patch` ставит свои маршруты поверх подмены
   * (Playwright берёт последний поставленный), `width` — для узкого экрана.
   */
  async function openPage({
    state = makeGroupState(),
    delay,
    patch,
    theme = 'light',
    width = 1400,
  } = {}) {
    const context = await browser.newContext({
      viewport: { width, height: 1100 },
      colorScheme: theme,
    });
    const page = await context.newPage();
    await bypassOnboarding(page);
    const errors = [];
    const requests = [];
    page.on('pageerror', (error) => errors.push(error.message.slice(0, 200)));
    page.on('console', (message) => {
      const text = message.text();
      if (message.type() === 'error' && !text.startsWith('Failed to load resource')) {
        errors.push(text.slice(0, 200));
      }
    });
    page.on('response', (response) => {
      if (response.status() < 400) return;
      // 5xx от НЕподменённого адреса — стенд перезапускается (сервер дев-режима
      // перезагружается на каждую правку), к странице групп не относится.
      if (response.status() >= 500 && !STUBBED.test(response.url())) {
        console.log(`инфо стенд ответил ${response.status()} ${response.url()}`);
        return;
      }
      errors.push(`${response.status()} ${response.url()}`);
    });
    page.on('request', (request) => requests.push(request.url()));
    // Неподменённый GET к API стенда переживает его перезапуск: 5xx и обрыв —
    // повтор до 60 с. Без этого страница ловила 502 в миг перезапуска сервера
    // (его перезапускает каждая чужая правка) и рисовала сбой вместо окна группы
    // (S-502). Подмена групп ставится ПОСЛЕ и потому отвечает первой.
    await page.route('**/api/**', async (route) => {
      // Поток событий (SSE) не буферизуется — его не повторяем.
      const request = route.request();
      if (request.method() !== 'GET' || /\/api\/events(\?|$)/.test(request.url())) {
        return route.fallback();
      }
      for (let attempt = 0; ; attempt += 1) {
        if (page.isClosed()) return undefined;
        const response = await route.fetch().catch(() => undefined);
        if (response && (response.status() < 500 || attempt >= 60)) {
          return route.fulfill({ response }).catch(() => undefined);
        }
        if (!response && attempt >= 60) return route.abort().catch(() => undefined);
        if (attempt === 0) console.log(`инфо стенд перезапускается, жду: ${route.request().url()}`);
        await pause(1000);
      }
    });
    await installGroupStubs(page, state, { delay });
    if (patch) await patch(page);
    await page.goto(`${BASE}/groups`);
    await page.waitForSelector('nav');
    // Подмены снимаются до закрытия: запрос, пойманный в миг закрытия, иначе
    // роняет весь прогон «Request context disposed» из обработчика подмены.
    const close = async () => {
      await page.unrouteAll({ behavior: 'ignoreErrors' });
      await context.close();
    };
    return { page, state, errors, requests, close, open: (name) => openGroup(page, name) };
  }

  async function finish(success) {
    await browser.close();
    front?.stop();
    console.log(bad === 0 ? success : `Проблем: ${bad}`);
    process.exit(bad === 0 ? 0 : 1);
  }

  return { check, openPage, finish };
}
