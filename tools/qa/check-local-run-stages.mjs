/**
 * Этапы хода локальной модели под ответом чата (этап 11, W2-5): «загружает модель», «ждёт
 * своей очереди», «читает промпт: 2048 из 4096 токенов», «пишет ответ: 120 токенов», застой.
 *
 * Две части.
 * - Экран (`PHASE=BEFORE|AFTER`, по умолчанию AFTER): живой фронт стенда, ответы сервера
 *   подменены (`page.route`) — разговор идёт на маршруте локальной модели, а
 *   `GET /api/local-models/activity` отдаёт по очереди каждый этап в той форме, в какой его
 *   собирает панель из ленты звена ядра. Кадр на этап в
 *   `.agent/screenshots/before-after/s11-local-stages/<PHASE>/`; AFTER сверяет текст строки.
 * - Провод (`WIRE=1` — после экрана, `WIRE=only` — один): одноразовая панель с ядром под
 *   надзором на временном доме — `GET /api/core/local/activity` отвечает `{routes}` (хост
 *   звеньев знает op `activity`), `GET /api/local-models/activity` — 200. Стенд человека,
 *   его конфиг и контур не трогаются.
 *
 * Запуск: `node tools/qa/check-local-run-stages.mjs` (нужен `pnpm dev`, браузеры — `pnpm qa:setup`).
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { startStand as startThrowaway } from './throwaway-stand.mjs';
import {
  PROJECT,
  chat,
  frame,
  openChat,
  openProject,
  projectShell,
  settings,
  sse,
} from '../help-shots/chat-stubs.mjs';

const WEB = process.env.APP_URL ?? 'http://localhost:8888';
const PHASE = (process.env.PHASE ?? 'AFTER').toUpperCase();
const WIRE = process.env.WIRE === '1';
/** Только провод (без экрана и без браузера стенда человека). */
const WIRE_ONLY = process.env.WIRE === 'only';
const OUT = join(process.cwd(), '.agent', 'screenshots', 'before-after', 's11-local-stages', PHASE);

let bad = 0;
const rows = [];
const check = (ok, what, seen) => {
  rows.push({ ok, what, seen });
  console.log(`${ok ? 'ок   ' : 'ПЛОХО'} ${what}${seen === undefined ? '' : ` — ${seen}`}`);
  if (!ok) bad += 1;
};

const CHAT = 'qa-local-stages';
const SERVER = { model: 'qwen3.6:27b-coding', quant: 'UD-Q4_K_XL', context: 131_072 };

/** Ход в форме `LocalActivity`, как его собирает `withHopActivity` сервера панели. */
function stage(at, over) {
  return {
    ...SERVER,
    stallMs: 120_000,
    inFlight: 1,
    startedAt: at - 30_000,
    lastRequestAt: at - 30_000,
    lastMoveAt: at,
    stalled: false,
    ...over,
  };
}

/** Этапы по порядку: что отдаёт сервер и что строка должна сказать (AFTER, ru). */
const STAGES = (at) => [
  { id: '01-starting', body: stage(at, { phase: 'starting' }), says: /сервер моделей поднимается/ },
  { id: '02-loading', body: stage(at, { phase: 'loading' }), says: /модель загружается в память/ },
  {
    id: '03-queued',
    body: stage(at, { phase: 'queued' }),
    says: /запрос ждёт, пока сервер его возьмёт/,
  },
  {
    id: '04-prompt',
    body: stage(at, { phase: 'prompt', prompt: { filled: 2048, total: 4096 }, decoded: 0 }),
    says: /читает промпт: 2\s?048 из 4\s?096 токенов/,
  },
  {
    id: '05-prompt-no-total',
    body: stage(at, { phase: 'prompt', prompt: { filled: 2048 }, decoded: 0 }),
    says: /читает промпт: 2\s?048 токенов/,
  },
  {
    id: '06-generating',
    body: stage(at, {
      phase: 'generating',
      prompt: { filled: 4096, total: 4096 },
      decoded: 120,
    }),
    says: /пишет ответ: 120 токенов/,
  },
  {
    id: '07-silent',
    body: stage(at, {
      phase: 'prompt',
      prompt: { filled: 2048, total: 4096 },
      decoded: 0,
      lastMoveAt: at - 45_000,
    }),
    says: /сервер молчит 4\d с/,
  },
  {
    id: '08-stalled',
    body: stage(at, {
      phase: 'prompt',
      prompt: { filled: 2048, total: 4096 },
      decoded: 0,
      lastMoveAt: at - 130_000,
      stalled: true,
    }),
    says: /движения нет 1[23]\d с/,
  },
  {
    // Тишина наступает БЕЗ смены ответа: лента звена отдаёт тот же кадр, пока нет движения, и
    // строка обязана дойти до «молчит» по своим часам, а не по следующему кадру.
    id: '09-silent-same-frame',
    body: stage(at, {
      phase: 'prompt',
      prompt: { filled: 2048, total: 4096 },
      decoded: 0,
      lastMoveAt: at - 15_000,
    }),
    waitMs: 9_000,
    says: /читает промпт: 2\s?048 из 4\s?096 токенов сервер молчит (2[2-9]|3\d) с/,
  },
];

async function screen(browser) {
  mkdirSync(OUT, { recursive: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.addInitScript(() =>
    window.localStorage.setItem(
      'agentdeck.mascot',
      JSON.stringify({ enabled: false, chatty: false, greeted: true }),
    ),
  );
  let current = stage(Date.now(), { phase: 'idle', inFlight: 0 });
  try {
    await settings(page);
    await projectShell(page);
    await page.route('**/api/chats', (route) =>
      route.fulfill({ json: [chat(CHAT, 'Разбор логов на своей модели')] }),
    );
    await page.route('**/api/chats/*/messages*', (route) =>
      route.fulfill({
        json: {
          messages: [
            {
              id: 'u1',
              role: 'user',
              blocks: [{ type: 'text', text: 'Найди, где теряются заказы.' }],
              timestamp: '2026-11-05T10:00:00.000Z',
            },
          ],
          total: 1,
          hasMore: false,
        },
      }),
    );
    await page.route('**/api/chat/active', (route) =>
      route.fulfill({ json: [{ chatId: CHAT, seq: 0 }] }),
    );
    // Поток отдаётся один раз и дальше висит: иначе страница переподключалась бы и сдалась.
    let hits = 0;
    await page.route(`**/api/chat/${CHAT}/stream*`, (route) => {
      hits += 1;
      if (hits > 1) return undefined;
      return route.fulfill(
        sse(frame({ kind: 'session', sessionId: CHAT, startedAt: Date.now() - 30_000 }, 1)),
      );
    });
    // Разговор идёт на локальной модели: план прогона стенда, маршрут — свой контур.
    await page.route('**/api/platform-run-plan/**', async (route) => {
      try {
        const response = await route.fetch();
        const body = await response.json().catch(() => ({}));
        await route.fulfill({
          json: {
            rules: {},
            ...body,
            routed: true,
            title: 'Локальная модель',
            platformId: 'local-ollama',
          },
        });
      } catch {
        /* контекст закрыт */
      }
    });
    await page.route('**/api/local-models/activity', (route) => route.fulfill({ json: current }));

    await openProject(page, WEB);
    await openChat(page, 'Разбор логов на своей модели');
    const status = page.locator('[role="status"][data-stage]').first();
    await status.waitFor({ timeout: 20_000 });

    const count = STAGES(0).length;
    for (let index = 0; index < count; index += 1) {
      // Кадр — от часов ЭТОГО шага: тишина считается от `lastMoveAt`, и общий срез времени
      // до цикла копил бы её по 2 с на шаг.
      const item = STAGES(Date.now())[index];
      current = item.body;
      // Опрос строки — раз в 1,5 с: ждём, пока кадр дойдёт до разметки.
      await page.waitForTimeout(item.waitMs ?? 2_200);
      const text = (await status.innerText()).replace(/\s+/g, ' ').trim();
      await status.screenshot({ path: join(OUT, `${item.id}.png`) });
      if (PHASE === 'AFTER') check(item.says.test(text), `этап ${item.id}`, text);
      else console.log(`BEFORE ${item.id}: ${text}`);
    }
    await page.screenshot({ path: join(OUT, '00-chat.png') });
  } finally {
    await page.close();
  }
}

/**
 * Провод на ОДНОРАЗОВОЙ панели с ядром под надзором (как у человека): панель → прокладка
 * `/api/core/*` → ядро → управляющий канал хоста звеньев (op `activity`). Ничего в полёте —
 * `{routes: []}`; ответ панели — 200 без этапа (сервера моделей на стенде нет).
 */
async function wire() {
  const stand = await startThrowaway({
    label: 'local-stages',
    web: false,
    core: { supervised: true },
  });
  try {
    let core;
    const deadline = Date.now() + 90_000;
    // Ядро поднимает надзор панели: первые ответы — «ядро поднимается».
    while (Date.now() < deadline) {
      core = await stand.api('/core/local/activity');
      if (core.status === 200) break;
      await new Promise((done) => setTimeout(done, 1_000));
    }
    check(
      core?.status === 200 && Array.isArray(core.body?.routes) && core.body.routes.length === 0,
      'ядро отдаёт ленту звена через прокладку панели (ничего в полёте — пусто)',
      `${core?.status} ${JSON.stringify(core?.body).slice(0, 160)}`,
    );
    const panel = await stand.api('/local-models/activity');
    check(
      panel.status === 200 && panel.body?.phase === undefined,
      'панель отдаёт ход локальной модели без этапа, когда ничего не идёт',
      `${panel.status} ${JSON.stringify(panel.body).slice(0, 160)}`,
    );
  } finally {
    await stand.stop();
  }
}

const browser = await chromium.launch();
try {
  if (!WIRE_ONLY) await screen(browser);
  if (WIRE || WIRE_ONLY) await wire();
} finally {
  await browser.close();
}
console.log(`\n${PROJECT.name}: ${rows.length} строк, плохих ${bad}`);
process.exit(bad > 0 ? 1 : 0);
