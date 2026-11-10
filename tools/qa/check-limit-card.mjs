/**
 * Карточка лимита в окне задачи ядра (этап 12, L1, P169, P184) — живой фронт `pnpm dev`, ответы ядра
 * подменены `page.route` (граница сети): доска с одной ждущей задачей, её вид с `windowWait` и, во
 * втором проходе, открытый вопрос точки 7 с вариантами перевода. Рисует настоящий код панели.
 *
 * Что видно:
 *   - задача в `waiting-window`: маршрут, вердикт, время сброса, варианты `cli:`/`model:` кнопками
 *     «Перенести в codex» / «Другая модель: …»;
 *   - клик «Перенести в codex» → ровно одна команда `set-cli {scope: task, scopeId: id задачи,
 *     adapter: codex, timing: now}`; клик по модели → `set-model {…, effort: null}`;
 *   - отказ ядра (`rejected`) показан его словами;
 *   - без вариантов — «других маршрутов нет», ни одной кнопки перевода;
 *   - сброс неизвестен — текст о перепроверке, не пустое время;
 *   - открыт вопрос точки 7 с теми же вариантами — кнопки только в вопросе («Перенести в codex»,
 *     ответ `cli:codex`), карточка окна их не дублирует;
 *   - без клика ни одной команды не уходит.
 *
 * Запуск: `node tools/qa/check-limit-card.mjs` при поднятом `pnpm dev` (`APP_URL` — другой фронт).
 * `SHOTS=<dir>` — кадры в обеих темах (`SHOT_TAG`, по умолчанию AFTER). Код выхода: 0 — сходится,
 * 1 — провал.
 */
import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { bypassOnboarding } from './bypass-onboarding.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const { taskViewSchema } = await import(
  pathToFileURL(join(ROOT, 'packages/contracts/src/core/task-view.ts')).href
);

const BASE = process.env.APP_URL ?? 'http://localhost:8888';
const SHOTS = process.env.SHOTS || '';
const TAG = process.env.SHOT_TAG || 'AFTER';

const TASK = '01900000-0000-7000-8000-0000000c0001';
const STEP = '01900000-0000-7000-8000-0000000c0201';
const UNIT = '01900000-0000-7000-8000-0000000c0301';
const ASK = '01900000-0000-7000-8000-0000000c0401';
const AT = Date.UTC(2026, 10, 8, 9, 0, 0);
const RESET = Date.UTC(2026, 10, 8, 14, 30, 0);
const ROUTE = 'claude-login';
const OFFERS = ['cli:codex', 'model:claude-sonnet-4-5'];

const zero = { input: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, output: 0, turns: 0 };

function viewOf(opts) {
  return taskViewSchema.parse({
    taskId: TASK,
    seq: 6,
    state: 'waiting-window',
    ended: null,
    steps: [
      {
        stepId: STEP,
        unitId: UNIT,
        stepKind: 'implement',
        stepDefId: 'work',
        round: 0,
        state: 'running',
        startedSeq: 3,
        budgetMs: 600000,
        outcome: null,
        reason: null,
      },
    ],
    sessions: [],
    checks: [],
    asks: opts.ask
      ? [
          {
            askId: ASK,
            state: 'open',
            point: 7,
            source: 'budget',
            dedupe: `exhausted:${ROUTE}:${STEP}`,
            stepId: STEP,
            lateAnswer: false,
            answer: null,
            defaultAction: null,
          },
        ]
      : [],
    budgets: [],
    windows: [],
    spend: {
      tokens: { ...zero, input: 1000, output: 200, turns: 2 },
      cost: { usd: 0.01, windowUnits: 0, unpricedTokens: 0, versions: {}, turns: 2 },
      bySession: {},
      byStep: {},
    },
    report: null,
    scenario: null,
    split: null,
    attention: null,
    windowWait: {
      stepId: STEP,
      routeId: ROUTE,
      verdict: opts.ask ? 'exhausted' : 'refused',
      resetAt: opts.reset === false ? null : RESET,
      alternatives: [],
      skipped: [`cli-login:${ROUTE}=${opts.ask ? 'exhausted' : 'refused'}`],
      offers: opts.offers ?? OFFERS,
      seq: 6,
    },
  });
}

function journalOf(opts) {
  const rows = [
    ['task.created', { title: 'Карточка лимита' }],
    ['step.started', { stepId: STEP, stepKind: 'implement', stepDefId: 'work', round: 0 }],
  ];
  if (opts.ask) {
    rows.push([
      'human.asked',
      {
        askId: ASK,
        point: 7,
        source: 'budget',
        dedupe: `exhausted:${ROUTE}:${STEP}`,
        question: `Маршрут ${ROUTE} исчерпан. Ждать сброса или перевести задачу кликом?`,
        options: ['Ждать сброса', 'Остановить', ...(opts.offers ?? OFFERS)],
        defaultAction: null,
      },
    ]);
  }
  return rows.map(([kind, data], i) => ({
    v: 1,
    seq: i + 1,
    at: AT + i * 1000,
    kind,
    ...(kind === 'step.started' || kind === 'human.asked' ? { stepId: STEP } : {}),
    data,
  }));
}

const CARD = {
  kind: 'task',
  id: TASK,
  taskId: TASK,
  title: 'Карточка лимита',
  stop: 'mr',
  column: 'waiting',
  state: 'running',
  waiting: true,
  questions: 0,
  takeover: null,
  moves: [],
  createdAt: AT,
};
const LIMITS = {
  inWork: { used: 1, cap: 2 },
  perDay: { used: 1, cap: null },
  paused: false,
  stopOnQuestion: false,
  defaultStop: 'mr',
};

/** Подмена ядра: доска, число страницы, список, вид, поток строк, команды (`opts.refuse` — отказ). */
async function installStub(page, opts) {
  const state = { commands: [] };
  const journal = journalOf(opts);
  await page.route(/\/api\/core\/(board|nonce|tasks|commands)(\/|\?|$)/, async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace(/^\/api\/core/, '');
    if (path === '/board') {
      return route.fulfill({ json: { cards: [CARD], entries: [], limits: LIMITS } });
    }
    if (path === '/nonce') {
      return route.fulfill({ json: { nonce: 'qa-limit-nonce', expiresAt: Date.now() + 60_000 } });
    }
    if (path === '/commands' && request.method() === 'POST') {
      const body = request.postDataJSON();
      state.commands.push(body);
      return route.fulfill({
        json: opts.refuse
          ? {
              cmdId: body.cmdId,
              status: 'rejected',
              code: 'unknown-adapter',
              reason: 'no codex',
              seq: 6,
            }
          : { cmdId: body.cmdId, status: 'applied', seq: 7 },
      });
    }
    if (path === '/tasks') {
      return route.fulfill({
        json: {
          tasks: [
            {
              taskId: TASK,
              live: true,
              seq: 6,
              state: 'waiting-window',
              ended: null,
              title: CARD.title,
              attention: null,
            },
          ],
        },
      });
    }
    if (path === `/tasks/${TASK}/events` || path.startsWith(`/tasks/${TASK}/events`)) {
      const after = Number.parseInt(request.headers()['last-event-id'] ?? '0', 10) || 0;
      const body = journal
        .filter((l) => l.seq > after)
        .map((l) => `id: ${l.seq}\nevent: ${l.kind}\ndata: ${JSON.stringify(l)}\n\n`)
        .join('');
      return route.fulfill({ status: 200, contentType: 'text/event-stream', body });
    }
    if (path === `/tasks/${TASK}`) {
      return route.fulfill({ json: { task: null, live: true, view: viewOf(opts) } });
    }
    if (path.startsWith(`/tasks/${TASK}/report`)) {
      return route.fulfill({ status: 404, json: { error: 'no-report' } });
    }
    return route.fallback();
  });
  return state;
}

/** Сравнение без порядка ключей: тело команды собирает разворот объектов. */
const canon = (v) =>
  JSON.stringify(v, (_k, x) =>
    x && typeof x === 'object' && !Array.isArray(x)
      ? Object.fromEntries(Object.entries(x).sort(([p], [q]) => p.localeCompare(q)))
      : x,
  );

let bad = 0;
const check = (text, ok, detail = '') => {
  if (!ok) bad += 1;
  console.log(`  ${ok ? '✓' : '✗'} ${text}${!ok && detail ? `\n      ${detail}` : ''}`);
  return ok;
};

async function shoot(page, target, name) {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  for (const theme of ['light', 'dark']) {
    await page.evaluate((t) => {
      document.documentElement.dataset.theme = t;
      document.documentElement.style.colorScheme = t;
    }, theme);
    await page.waitForTimeout(250);
    // Окно карточки прокручивается: кадр — вся страница, окно прокручено к первому вопросу или
    // карточке лимита, а не снимок элемента, обрезанный по видимой части.
    await target.evaluate((el) => {
      el.querySelector('[data-core-ask], [data-limit-card]')?.scrollIntoView({ block: 'start' });
    });
    await page.screenshot({ path: join(SHOTS, `${name}-${theme}_${TAG}.png`) });
  }
  await page.evaluate(() => {
    document.documentElement.dataset.theme = 'light';
  });
}

/** Открыть окно ждущей задачи на доске; вернуть страницу, окно и состояние подмены. */
async function openCard(browser, opts) {
  const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await bypassOnboarding(page);
  const state = await installStub(page, opts);
  await page.goto(`${BASE}/core`, { waitUntil: 'domcontentloaded' });
  await page.locator(`[data-board-card="${TASK}"]`).first().click({ timeout: 20_000 });
  const modal = page.locator(`[data-card-modal="${TASK}"]`);
  await modal.waitFor({ timeout: 15_000 });
  await page.waitForTimeout(800);
  return { page, modal, state, errors };
}

const offerButtons = (scope) => scope.locator('[data-limit-offer]');

async function main() {
  const browser = await chromium.launch();
  try {
    // 1. Ожидание окна с вариантами: время сброса, кнопки, клик → set-cli / set-model.
    {
      console.log('1. waiting-window, два варианта, сброс известен');
      const { page, modal, state, errors } = await openCard(browser, {});
      const card = modal.locator('[data-limit-card]');
      const shown = await card.count();
      check('карточка лимита в окне задачи', shown === 1, `найдено ${shown}`);
      await shoot(page, modal, 'card-window-offers');
      if (shown === 1) {
        const text = (await card.innerText()).replace(/\s+/g, ' ');
        check(`маршрут назван (${ROUTE})`, text.includes(ROUTE), text);
        const reset = new Date(RESET).toLocaleString('ru', { hour: '2-digit', minute: '2-digit' });
        check(`время сброса показано (${reset})`, text.includes(reset), text);
        const labels = await offerButtons(card).allInnerTexts();
        check(
          'варианты кнопками: «Перенести в codex», «Другая модель: claude-sonnet-4-5»',
          JSON.stringify(labels) ===
            JSON.stringify(['Перенести в codex', 'Другая модель: claude-sonnet-4-5']),
          JSON.stringify(labels),
        );
        check('без клика команд нет', state.commands.length === 0, JSON.stringify(state.commands));
        await offerButtons(card).first().click();
        await page.waitForTimeout(600);
        const sent = state.commands.map((c) => ({ kind: c.kind, fields: c.fields }));
        check(
          'клик «Перенести в codex» → одна команда set-cli (task, now)',
          canon(sent) ===
            canon([
              {
                kind: 'set-cli',
                fields: { scope: 'task', scopeId: TASK, adapter: 'codex', timing: 'now' },
              },
            ]),
          JSON.stringify(sent),
        );
        check(
          'команда с id задачи в target',
          state.commands[0]?.target?.taskId === TASK,
          JSON.stringify(state.commands[0]?.target),
        );
        check(
          'итог «перевод принят» виден',
          (await card.locator('[data-limit-status="applied"]').count()) === 1,
        );
      }
      check('без ошибок страницы', errors.length === 0, errors.join(' | '));
      await page.close();
    }

    // 2. Клик по модели → set-model; отказ ядра — его словами.
    {
      console.log('2. клик по модели, ядро отказывает');
      const { page, modal, state } = await openCard(browser, { refuse: true });
      const card = modal.locator('[data-limit-card]');
      if ((await card.count()) === 1) {
        await offerButtons(card).nth(1).click();
        await page.waitForTimeout(600);
        const sent = state.commands.map((c) => ({ kind: c.kind, fields: c.fields }));
        check(
          'клик «Другая модель» → set-model (task, effort null, now)',
          canon(sent) ===
            canon([
              {
                kind: 'set-model',
                fields: {
                  scope: 'task',
                  scopeId: TASK,
                  model: 'claude-sonnet-4-5',
                  effort: null,
                  timing: 'now',
                },
              },
            ]),
          JSON.stringify(sent),
        );
        const refused = card.locator('[data-limit-status="rejected"]');
        check(
          'отказ ядра показан его словами (no codex)',
          (await refused.count()) === 1 && (await refused.innerText()).includes('no codex'),
        );
      } else check('карточка лимита в окне задачи', false);
      await page.close();
    }

    // 3. Вариантов нет, срок сброса неизвестен.
    {
      console.log('3. без вариантов, сброс неизвестен');
      const { page, modal } = await openCard(browser, { offers: [], reset: false });
      const card = modal.locator('[data-limit-card]');
      if ((await card.count()) === 1) {
        check('ни одной кнопки перевода', (await offerButtons(card).count()) === 0);
        check(
          '«других маршрутов нет» и «срок неизвестен»',
          (await card.locator('[data-limit-no-offers]').count()) === 1 &&
            (await card.locator('[data-limit-reset="unknown"]').count()) === 1,
        );
        await shoot(page, modal, 'card-window-no-offers');
      } else check('карточка лимита в окне задачи', false);
      await page.close();
    }

    // 4. Открыт вопрос точки 7: кнопки перевода — только в вопросе, ответ текстом варианта.
    {
      console.log('4. исчерпание: вопрос точки 7 с вариантами');
      const { page, modal, state } = await openCard(browser, { ask: true });
      const ask = modal.locator(`[data-core-ask="${ASK}"]`);
      await ask.waitFor({ timeout: 10_000 }).catch(() => undefined);
      const option = ask.locator('[data-ask-option="cli:codex"]');
      const label = (await option.count()) === 1 ? (await option.innerText()).trim() : '';
      check('вариант вопроса подписан «Перенести в codex»', label === 'Перенести в codex', label);
      const card = modal.locator('[data-limit-card]');
      check(
        'карточка окна не дублирует кнопки при открытом вопросе',
        (await card.count()) === 1 &&
          (await offerButtons(card).count()) === 0 &&
          (await card.locator('[data-limit-ask-holds]').count()) === 1,
      );
      await shoot(page, modal, 'card-exhausted-ask');
      if (label) {
        await option.click();
        await page.waitForTimeout(600);
        const sent = state.commands.map((c) => ({ kind: c.kind, fields: c.fields }));
        check(
          'клик → ответ «cli:codex» на вопрос точки 7, не set-cli',
          canon(sent) === canon([{ kind: 'answer', fields: { askId: ASK, answer: 'cli:codex' } }]),
          JSON.stringify(sent),
        );
      }
      await page.close();
    }
  } finally {
    await browser.close();
  }
  console.log(bad === 0 ? '\nOK' : `\nFAILED: ${bad}`);
  process.exit(bad === 0 ? 0 : 1);
}

await main();
