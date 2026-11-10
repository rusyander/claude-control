/**
 * Карточка лимита в чате (этап 12, L3, P171) — живой фронт `pnpm dev`, сеть подменена `page.route`:
 * разговор в списке, его лента, отправка (поток хода: задача ядра, окно `rejected`, ошибка, конец),
 * вид задачи ядра с `windowWait`, команды ядра, правка настроек и перенос разговора. Рисует
 * настоящий код панели; ни одна запись не доходит до живой панели (любой не-GET, не подменённый
 * здесь, обрывается и считается провалом).
 *
 * Что видно:
 *   - ход упёрся в лимит → карточка лимита в ленте: время сброса и что последнее сообщение уйдёт
 *     ещё раз, один раз, само; «Повторить»/«Продолжить» панели (в ленте и в шапке) спрятаны —
 *     повтор ведёт ядро, второй ход панели дал бы два хода (P171);
 *   - без клика ничего не уходит: ни команды ядра, ни правки настроек, ни второй отправки;
 *   - «Ждать сброса» → ничего не отправлено, кнопки свёрнуты, строка ожидания осталась;
 *   - «Другая модель: X» → ровно одна команда `set-model` (задача, сейчас, усилие null);
 *   - «Перенести в codex» → одна правка настроек `{provider: codex}`, затем перенос ЭТОГО
 *     разговора одним `carry/apply`; неготовый кандидат — причина словами, переноса нет;
 *   - цели переноса — каждый CLI детекта панели со входом (стоит и с конфигурацией), кроме CLI
 *     разговора; вариант `cli:` ядра (CLI его набора) целью не считается;
 *   - вариантов нет — только «Ждать сброса».
 *
 * Запуск: `node tools/qa/check-chat-limit-card.mjs` при поднятом `pnpm dev` (`APP_URL` — другой
 * фронт). `SHOTS=<dir>` — кадры в обеих темах (`SHOT_TAG`, по умолчанию AFTER). Выход 0 — сходится.
 */
import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { bypassOnboarding } from './bypass-onboarding.mjs';
import { dismissAccess } from './chat-walk.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const { taskViewSchema } = await import(
  pathToFileURL(join(ROOT, 'packages/contracts/src/core/task-view.ts')).href
);

const BASE = process.env.APP_URL ?? 'http://localhost:8888';
const SHOTS = process.env.SHOTS || '';
const TAG = process.env.SHOT_TAG || 'AFTER';

const CHAT = '5b2d7c1e-3f4a-4b6c-8d9e-0a1b2c3d4e5f';
const TASK = '01900000-0000-7000-8000-0000000d0001';
const STEP = '01900000-0000-7000-8000-0000000d0201';
// Сброс — всегда впереди: прошедший сброс карточка честно снимает (ответ модели после сброса уже
// в ленте), и закреплённая дата превращала проверку в мину замедленного действия.
const RESET = Math.floor((Date.now() + 3 * 3_600_000) / 60_000) * 60_000;
const MODEL = 'claude-sonnet-4-5';
// `cli:qwen` ядра — CLI его разрешённого набора, не цель переноса: карточка его не показывает.
const OFFERS = [`model:${MODEL}`, 'cli:qwen'];
const detectRow = (id, cliInstalled, configPresent) => ({
  id,
  name: id,
  status: 'verified',
  cliCommand: id,
  cliInstalled,
  configPresent,
  configPaths: [],
});
/** Детект панели: Claude и Codex с входом, Qwen стоит без конфигурации, Gemini не стоит. */
const DETECT = [
  detectRow('claude', true, true),
  detectRow('codex', true, true),
  detectRow('qwen', true, false),
  detectRow('gemini', false, false),
];
const LIMIT_TEXT = "You've hit your limit · resets 2:30pm";

const zero = { input: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, output: 0, turns: 0 };

function viewOf(opts) {
  return taskViewSchema.parse({
    taskId: TASK,
    seq: 5,
    state: 'waiting-window',
    ended: null,
    steps: [
      {
        stepId: STEP,
        unitId: '01900000-0000-7000-8000-0000000d0301',
        stepKind: 'implement',
        stepDefId: 'chat',
        round: 0,
        state: 'running',
        startedSeq: 2,
        budgetMs: 600000,
        outcome: null,
        reason: null,
      },
    ],
    sessions: [],
    checks: [],
    asks: [],
    budgets: [],
    windows: [],
    spend: {
      tokens: { ...zero, input: 900, output: 100, turns: 1 },
      cost: { usd: 0, windowUnits: 0, unpricedTokens: 0, versions: {}, turns: 1 },
      bySession: {},
      byStep: {},
    },
    report: null,
    scenario: null,
    split: null,
    attention: null,
    windowWait: {
      stepId: STEP,
      routeId: 'claude-login',
      verdict: 'refused',
      resetAt: RESET,
      alternatives: [],
      skipped: ['cli-login:claude-login=refused'],
      offers: opts.offers ?? OFFERS,
      seq: 5,
    },
  });
}

// Подмена, разошедшаяся с контрактом, падает здесь, до браузера, а не в обработчике маршрута.
viewOf({});
viewOf({ offers: [] });

function candidate(opts) {
  return {
    key: CHAT,
    providerId: 'claude',
    chatId: CHAT,
    title: 'Почини сборку графиков',
    cwd: 'C:/qa/reports',
    updatedAt: new Date(RESET - 3_600_000).toISOString(),
    checkpoint: 'C:/qa/reports/PROGRESS.md',
    chainDepth: 0,
    ready: opts.carryReady !== false,
    ...(opts.carryReady === false ? { reason: 'checkpoint_missing' } : {}),
  };
}

/** Поток хода: задача ядра, окно отказало, ход кончился ошибкой и концом (как `core-run`). */
function turnBody() {
  const frames = [
    { kind: 'coreTask', taskId: TASK, project: 'reports' },
    { kind: 'limit', resetsAt: Math.floor(RESET / 1000), type: 'five_hour', status: 'rejected' },
    { kind: 'error', message: LIMIT_TEXT },
    { kind: 'done', costUsd: 0, durationMs: 1200, sessionId: CHAT },
  ];
  return frames.map((f, i) => `data: ${JSON.stringify({ ...f, seq: i + 1 })}\n\n`).join('');
}

async function installStub(page, opts) {
  const state = { sends: 0, commands: [], grants: [], patches: [], applies: [], stray: [] };
  const now = Date.now();
  const chat = {
    id: CHAT,
    title: 'Почини сборку графиков',
    project: 'reports',
    projectPath: 'C:/qa/reports',
    isSandbox: false,
    messageCount: 2,
    createdAt: new Date(now - 30 * 60_000).toISOString(),
    updatedAt: new Date(now).toISOString(),
    preview: '',
  };
  // Страховка: запись, которую эта подмена не знает, до живой панели не доходит.
  await page.route('**/api/**', (route) => {
    const request = route.request();
    if (request.method() === 'GET' || request.method() === 'HEAD') return route.fallback();
    state.stray.push(`${request.method()} ${new URL(request.url()).pathname}`);
    return route.abort();
  });
  await page.route('**/api/chats', (route) =>
    route.request().method() === 'GET' ? route.fulfill({ json: [chat] }) : route.fallback(),
  );
  await page.route(`**/api/chats/${CHAT}/messages*`, (route) =>
    route.fulfill({
      json: {
        messages: [
          {
            id: 'qa-l-1',
            role: 'user',
            blocks: [{ type: 'text', text: 'Посмотри, почему не собираются графики.' }],
            timestamp: new Date(now - 30 * 60_000).toISOString(),
          },
          {
            id: 'qa-l-2',
            role: 'assistant',
            blocks: [{ type: 'text', text: 'Сборка падает на импорте темы — нашёл место.' }],
            timestamp: new Date(now - 29 * 60_000).toISOString(),
          },
        ],
        total: 2,
        hasMore: false,
      },
    }),
  );
  // Цели «Перенести в X» — детект панели и CLI разговора, а не машина, на которой идёт проверка.
  await page.route('**/api/providers/detect', (route) =>
    route.fulfill({ json: { active: 'claude', providers: opts.detect ?? DETECT } }),
  );
  await page.route('**/api/chat/core-cli/**', (route) =>
    route.fulfill({ json: { cli: opts.cli ?? 'claude' } }),
  );
  await page.route('**/api/chat/send', (route) => {
    state.sends += 1;
    return route.fulfill({ status: 200, contentType: 'text/event-stream', body: turnBody() });
  });
  await page.route(/\/api\/core\/(nonce|tasks|commands)(\/|\?|$)/, (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace(/^\/api\/core/, '');
    if (path === '/nonce')
      return route.fulfill({ json: { nonce: 'qa-chat-limit', expiresAt: Date.now() + 60_000 } });
    if (path === '/commands' && request.method() === 'POST') {
      const body = request.postDataJSON();
      // Грант правки шлёт тумблер автоподтверждения чата (стенд может держать его включённым) —
      // к карточке лимита он не относится и в счёт её команд не идёт.
      if (body.kind === 'grant') state.grants.push(body);
      else state.commands.push(body);
      return route.fulfill({ json: { cmdId: body.cmdId, status: 'applied', seq: 6 } });
    }
    if (path === `/tasks/${TASK}`)
      return route.fulfill({ json: { task: null, live: true, view: viewOf(opts) } });
    if (path.startsWith(`/tasks/${TASK}/events`))
      return route.fulfill({ status: 200, contentType: 'text/event-stream', body: '' });
    return route.fallback();
  });
  let provider = 'claude';
  // Ответ правки — последние прочитанные живые настройки с правкой поверх; сама правка в панель
  // не уходит.
  let liveSettings = {};
  await page.route('**/api/settings', async (route) => {
    const request = route.request();
    if (request.method() === 'GET') {
      const live = await route.fetch();
      liveSettings = await live.json();
      return route.fulfill({ response: live, json: liveSettings });
    }
    if (request.method() !== 'PATCH') return route.fallback();
    const patch = request.postDataJSON();
    state.patches.push(patch);
    if (typeof patch.provider === 'string') provider = patch.provider;
    return route.fulfill({ json: { ...liveSettings, ...patch } });
  });
  await page.route('**/api/portability/carry', (route) =>
    route.fulfill({
      json: { target: provider, candidates: provider === 'claude' ? [] : [candidate(opts)] },
    }),
  );
  await page.route('**/api/portability/carry/apply', (route) => {
    const body = route.request().postDataJSON();
    state.applies.push(body);
    return route.fulfill({
      json: {
        target: provider,
        outcomes: body.keys.map((key) => ({
          key,
          carried: true,
          chatId: 'codex-qa-1',
          chainDepth: 1,
          noticedSource: true,
        })),
      },
    });
  });
  return state;
}

let bad = 0;
const check = (text, ok, detail = '') => {
  if (!ok) bad += 1;
  console.log(`  ${ok ? '✓' : '✗'} ${text}${!ok && detail ? `\n      ${detail}` : ''}`);
  return ok;
};

async function shoot(page, name) {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  for (const theme of ['light', 'dark']) {
    await page.evaluate((t) => {
      document.documentElement.dataset.theme = t;
      document.documentElement.style.colorScheme = t;
    }, theme);
    await page.waitForTimeout(250);
    await page
      .locator('[data-chat-limit]')
      .first()
      .scrollIntoViewIfNeeded()
      .catch(() => undefined);
    await page.screenshot({ path: join(SHOTS, `${name}-${theme}_${TAG}.png`) });
  }
  await page.evaluate(() => {
    document.documentElement.dataset.theme = 'light';
  });
}

/** Открыть разговор и отправить слово: ход упирается в лимит. */
async function hitLimit(browser, opts) {
  const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await bypassOnboarding(page);
  const state = await installStub(page, opts);
  await page.goto(`${BASE}/chat?id=${CHAT}`, { waitUntil: 'domcontentloaded' });
  const input = page.locator('textarea[data-chat-input]');
  await input.waitFor({ timeout: 60_000 });
  await dismissAccess(page);
  await page.getByText('нашёл место').first().waitFor({ timeout: 20_000 });
  await input.fill('Почини импорт темы и пересобери.');
  await input.press('Enter');
  await page
    .locator('[data-chat-error]')
    .first()
    .waitFor({ timeout: 15_000 })
    .catch(() => undefined);
  await page.waitForTimeout(1500);
  return { page, state, errors };
}

const card = (page) => page.locator('[data-chat-limit]');
const panelResend = (page) =>
  page
    .getByRole('button', { name: /^(Повторить|Продолжить|Разрешить и продолжить)$/ })
    .filter({ visible: true });
const nothingSent = (state) =>
  state.commands.length === 0 && state.patches.length === 0 && state.applies.length === 0;

async function main() {
  const browser = await chromium.launch();
  try {
    {
      console.log('1. ход упёрся в лимит: карточка, повтора панели нет, без клика ничего');
      const { page, state, errors } = await hitLimit(browser, {});
      await shoot(page, 'chat-limit-card');
      const shown = await card(page).count();
      check('карточка лимита в ленте', shown === 1, `найдено ${shown}`);
      const text = shown === 1 ? (await card(page).innerText()).replace(/\s+/g, ' ') : '';
      const reset = new Date(RESET).toLocaleString('ru', { hour: '2-digit', minute: '2-digit' });
      check(`время сброса (${reset})`, text.includes(reset), text);
      check(
        'сказано: последнее сообщение уйдёт ещё раз, один раз',
        /ещё раз/.test(text) && /один раз/.test(text),
        text,
      );
      const resend = await panelResend(page).count();
      check('«Повторить»/«Продолжить» панели спрятаны (лента и шапка)', resend === 0, `${resend}`);
      await page.waitForTimeout(2500);
      check('ровно одна отправка, второй хода панель не шлёт', state.sends === 1, `${state.sends}`);
      check('без клика ни команды, ни правки настроек', nothingSent(state), JSON.stringify(state));
      const labels = await card(page).locator('button').allInnerTexts();
      check(
        'кнопки: «Ждать сброса», «Другая модель: …», «Перенести в codex»',
        JSON.stringify(labels.map((l) => l.trim())) ===
          JSON.stringify(['Ждать сброса', `Другая модель: ${MODEL}`, 'Перенести в codex']),
        JSON.stringify(labels),
      );
      if (shown === 1) {
        await card(page).getByRole('button', { name: 'Ждать сброса' }).click();
        await page.waitForTimeout(500);
        check('«Ждать сброса» ничего не отправил', nothingSent(state) && state.sends === 1);
        check(
          'кнопки свёрнуты, строка ожидания осталась',
          (await card(page).locator('button').count()) === 0 &&
            (await card(page).locator('[data-chat-limit-waiting]').count()) === 1,
        );
        await shoot(page, 'chat-limit-waiting');
      }
      check('без ошибок страницы', errors.length === 0, errors.join(' | '));
      check('ни одной чужой записи', state.stray.length === 0, state.stray.join(', '));
      await page.close();
    }
    {
      console.log('2. «Другая модель» → одна команда set-model');
      const { page, state } = await hitLimit(browser, {});
      const button = card(page).locator(`[data-chat-limit-offer="model:${MODEL}"]`);
      if ((await button.count()) === 1) {
        await button.click();
        await page.waitForTimeout(700);
        const sent = state.commands.map((c) => ({ kind: c.kind, fields: c.fields }));
        check(
          'одна команда set-model {task, now, effort null}',
          state.commands.length === 1 &&
            state.commands[0].kind === 'set-model' &&
            state.commands[0].target?.taskId === TASK &&
            JSON.stringify(state.commands[0].fields) ===
              JSON.stringify({
                scope: 'task',
                scopeId: TASK,
                timing: 'now',
                model: MODEL,
                effort: null,
              }),
          JSON.stringify(sent),
        );
        check('настройки не тронуты', state.patches.length === 0 && state.applies.length === 0);
        check(
          'итог «принято» виден',
          (await card(page).locator('[data-chat-limit-status="applied"]').count()) === 1,
        );
      } else check('кнопка «Другая модель»', false);
      check('ни одной чужой записи', state.stray.length === 0, state.stray.join(', '));
      await page.close();
    }
    {
      console.log('3. «Перенести в codex» → провайдер и перенос этого разговора одним кликом');
      const { page, state } = await hitLimit(browser, {});
      const button = card(page).locator('[data-chat-limit-offer="cli:codex"]');
      if ((await button.count()) === 1) {
        await button.click();
        await card(page)
          .locator('[data-chat-limit-status="carried"]')
          .waitFor({ timeout: 10_000 })
          .catch(() => undefined);
        check(
          'одна правка настроек {provider: codex}',
          JSON.stringify(state.patches) === JSON.stringify([{ provider: 'codex' }]),
          JSON.stringify(state.patches),
        );
        check(
          'один перенос этого разговора',
          JSON.stringify(state.applies) === JSON.stringify([{ keys: [CHAT] }]),
          JSON.stringify(state.applies),
        );
        check('команд ядра нет', state.commands.length === 0, JSON.stringify(state.commands));
        check(
          'итог «перенесено» виден',
          (await card(page).locator('[data-chat-limit-status="carried"]').count()) === 1,
        );
        await shoot(page, 'chat-limit-carried');
      } else check('кнопка «Перенести в codex»', false);
      check('ни одной чужой записи', state.stray.length === 0, state.stray.join(', '));
      await page.close();
    }
    {
      console.log('4. кандидат не готов → причина, переноса нет');
      const { page, state } = await hitLimit(browser, { carryReady: false });
      const button = card(page).locator('[data-chat-limit-offer="cli:codex"]');
      if ((await button.count()) === 1) {
        await button.click();
        const status = card(page).locator('[data-chat-limit-status="not-carried"]');
        await status.waitFor({ timeout: 10_000 }).catch(() => undefined);
        check('переноса нет', state.applies.length === 0, JSON.stringify(state.applies));
        check(
          'причина названа словами',
          (await status.count()) === 1 && (await status.innerText()).trim().length > 20,
        );
      } else check('кнопка «Перенести в codex»', false);
      await page.close();
    }
    {
      console.log('5. разговор Codex → «Перенести в claude», самого Codex среди целей нет');
      const { page, state } = await hitLimit(browser, { offers: [], cli: 'codex' });
      const labels = await card(page).locator('button').allInnerTexts();
      check(
        'кнопки: «Ждать сброса», «Перенести в claude»',
        JSON.stringify(labels.map((l) => l.trim())) ===
          JSON.stringify(['Ждать сброса', 'Перенести в claude']),
        JSON.stringify(labels),
      );
      check('без клика ничего', nothingSent(state) && state.sends === 1);
      await page.close();
    }
    {
      console.log(
        '6. вариантов нет (ни моделей ядра, ни другого CLI с входом) → только «Ждать сброса»',
      );
      const { page, state } = await hitLimit(browser, {
        offers: [],
        detect: [detectRow('claude', true, true), detectRow('qwen', true, false)],
      });
      const labels = await card(page).locator('button').allInnerTexts();
      check(
        'одна кнопка «Ждать сброса»',
        JSON.stringify(labels.map((l) => l.trim())) === JSON.stringify(['Ждать сброса']),
        JSON.stringify(labels),
      );
      check('без клика ничего', nothingSent(state) && state.sends === 1);
      await page.close();
    }
  } finally {
    await browser.close();
  }
  console.log(bad === 0 ? '\nOK' : `\nFAILED: ${bad}`);
  process.exit(bad === 0 ? 0 : 1);
}

await main();
