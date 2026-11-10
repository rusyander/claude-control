/**
 * Доска задач ядра `/core` (этап 12, B7–B9, D13, P160) — живой фронт `pnpm dev`, ответы ядра
 * подменены `page.route`: доске нужен набор карточек всех видов (запись во «Входящих», очередь, две
 * задачи одной группы, ждущая человека, MR, закрытая), а живой журнал ядра такого набора не держит.
 * Подмена — граница сети: колонки, счёт, чип «Ждёт вас», ходы и окно карточки рисует настоящий код
 * панели из настоящего ответа формы `BoardReply`.
 *
 * Что видно:
 *   - `/core` открывается доской; «Список» — переключатель рядом;
 *   - счёт колонок = ответ ядра; чип «Ждёт вас» = карточки с флагом `waiting`, а неблокирующий
 *     вопрос — значок на карточке, а не «ждёт вас»;
 *   - окно записи без задачи: расход, агенты, ход — «нет данных», не 0; кнопки ходов — ровно
 *     разрешённые ядром; ход уходит телом `{cmdId, entryId, to, proof}`, доска перечитывается и
 *     показывает колонку ядра;
 *   - отказ хода (409, ядро успело сменить разрешённое) — причиной и списком «Сейчас можно»;
 *   - окно задачи на стадии MR — название MR и ссылка «Открыть ленту»;
 *   - `/groups` → доска полосами групп; «Закрытые» — закрытая карточка и прежние запуски;
 *   - шапка чата: «Доска · ждёт вас: N» из того же ответа, клик ведёт на доску;
 *   - вариации: доска отвечает 501 — «Доска не отвечает», в чате кнопка без числа; ответ доски
 *     задержан — до ответа скелет, ни пустой доски, ни «нет данных».
 *
 * Запуск: `node tools/qa/check-core-board.mjs` при поднятом `pnpm dev` (`APP_URL` — другой фронт).
 * `SHOTS=<dir>` — кадры в обеих темах (`SHOT_TAG`, по умолчанию AFTER). Код выхода: 0 — сходится,
 * 1 — провал.
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { bypassOnboarding } from './bypass-onboarding.mjs';
import { CORE_STUB_VIEW } from './core-task-stub.mjs';
import { STUBBED as LEGACY_STUBBED, installLegacyGroupsStub } from './legacy-groups-stub.mjs';

const BASE = process.env.APP_URL ?? 'http://localhost:8888';
const SHOTS = process.env.SHOTS || '';
const TAG = process.env.SHOT_TAG || 'AFTER';

const id = (n) => `01900000-0000-7000-8000-0000000b${String(n).padStart(4, '0')}`;
export const BOARD_IDS = {
  inbox: id(1),
  queued: id(2),
  work: id(3),
  stale: id(4),
  waiting: id(5),
  mr: id(6),
  closed: id(7),
};
export const BOARD_GROUP = '01900000-0000-7000-8000-00000000c0de';
export const BOARD_MR_TITLE = 'Доска задач: колонки из ответа ядра';
const LEGACY_CHAT = 'legacy-board-chat';
const AT = Date.UTC(2026, 10, 8, 9, 0, 0);

function card(key, patch) {
  return {
    kind: 'task',
    id: BOARD_IDS[key],
    taskId: BOARD_IDS[key],
    title: key,
    stop: 'mr',
    waiting: false,
    questions: 0,
    takeover: null,
    moves: [],
    createdAt: AT,
    ...patch,
  };
}

function entry(key, patch) {
  const { taskId: _drop, ...rest } = card(key, patch);
  return { ...rest, kind: 'entry', entryId: BOARD_IDS[key] };
}

/** Набор карточек доски: по одной каждого вида, две задачи — одной группы ядра. */
export function boardCards() {
  return [
    entry('inbox', {
      column: 'inbox',
      state: 'inbox',
      title: 'Разобрать журнал сборки',
      stop: 'plan',
      preset: 'feature',
      source: { kind: 'manual', title: 'Разобрать журнал сборки' },
      moves: ['queue', 'rejected'],
    }),
    entry('queued', {
      column: 'queue',
      state: 'queued',
      title: 'Обновить справку раздела',
      preset: 'feature',
      source: { kind: 'chat', title: 'Обновить справку раздела' },
      rank: 1,
      moves: ['inbox', 'rejected'],
    }),
    card('work', {
      column: 'work',
      state: 'running',
      title: 'Починить парсер',
      groupId: BOARD_GROUP,
      units: { done: 1, total: 3 },
    }),
    // Ядро успело закрыть задачу между чтением доски и ходом: ход «Отклонить» получит 409.
    card('stale', {
      column: 'work',
      state: 'running',
      title: 'Описать итог',
      groupId: BOARD_GROUP,
      questions: 3,
      moves: ['rejected'],
    }),
    card('waiting', {
      column: 'waiting',
      state: 'running',
      title: 'Выбрать формат отчёта',
      waiting: true,
      questions: 1,
    }),
    card('mr', {
      column: 'mr',
      state: 'running',
      title: 'Доска задач',
      mr: {
        url: 'https://forge.example.com/proj/app/-/merge_requests/42',
        iid: 42,
        title: BOARD_MR_TITLE,
        state: 'opened',
      },
    }),
    card('closed', { column: 'closed', state: 'done', title: 'Старая задача' }),
  ];
}

/** Связанная пара «Входящих» (B11, P186): вторая запись режима `related`. */
export const BOARD_RELATED_ID = id(8);
/** Проза отказа ядра — та же, что пишет `moves.ts` `applyMerge`, когда запись ушла в очередь. */
export const MERGE_REFUSAL_REASON = `entry ${BOARD_RELATED_ID} (PROJ-11) is queued: only inbox entries merge`;

/** Проза отказа хода «Отклонить» у карточки, которую ядро успело отклонить (`moves.ts` applyMove). */
export const MOVE_REFUSAL_REASON = 'move rejected is not allowed from rejected';

/**
 * Карточки режима `related`: запись «Входящих» тикетом PROJ-10 с ходом `merge` и подсказкой на
 * вторую запись PROJ-11 (общий эпик и путь) — так обходы доступности и клавиатуры видят значок
 * «связано» на плитке и раздел «Связанные карточки» в окне. Остальная доска — как без режима.
 */
function relatedCards() {
  const cards = boardCards();
  const inbox = cards.find((c) => c.id === BOARD_IDS.inbox);
  Object.assign(inbox, {
    title: 'PROJ-10 Форма входа',
    source: { kind: 'tracker', key: 'PROJ-10', title: 'PROJ-10 Форма входа' },
    moves: ['queue', 'rejected', 'merge'],
    related: [
      { entryId: BOARD_RELATED_ID, title: 'PROJ-11 Ошибки входа', reasons: ['path', 'epic'] },
    ],
  });
  const pair = entry('inbox', {
    column: 'inbox',
    state: 'inbox',
    title: 'PROJ-11 Ошибки входа',
    stop: 'plan',
    preset: 'tracker-ticket',
    source: { kind: 'tracker', key: 'PROJ-11', title: 'PROJ-11 Ошибки входа' },
    moves: ['queue', 'rejected', 'merge'],
    related: [
      { entryId: BOARD_IDS.inbox, title: 'PROJ-10 Форма входа', reasons: ['epic', 'path'] },
    ],
  });
  return [...cards, { ...pair, id: BOARD_RELATED_ID, entryId: BOARD_RELATED_ID }];
}

const LIMITS = {
  inWork: { used: 2, cap: 2 },
  perDay: { used: 4, cap: null },
  paused: false,
  stopOnQuestion: false,
  defaultStop: 'mr',
};

const CORE_ROUTES = /\/api\/core\/(board|nonce|tasks)(\/|\?|$)/;

/**
 * Какие запросы отвечает подмена доски (ответы ядра и сетка прежних групп): страж записи
 * (`modal-box.mjs` requestGuard) отдаёт их ей, а не обрывает, иначе ход с доски не дождался бы
 * ответа подмены.
 */
export const STUBBED = new RegExp(`${CORE_ROUTES.source}|${LEGACY_STUBBED.source}`);

/**
 * Подменить ответы ядра доске (`/api/core/board*`, `/nonce`, `/tasks`, `/tasks/:id`) и сетке
 * прежних групп. `mode.fail` — доска 501, `mode.delayMs` — ответ доски задержан,
 * `mode.configIssues` — доска назвала ошибки конфига, `mode.related` — связанная пара «Входящих»
 * с ходом `merge`, `mode.mergeRefusal` (или `state.mergeRefusal`) — `merge` получает отказ ядра
 * 409. Возвращает состояние: карточки (ход их
 * меняет) и тела ходов, ушедшие в ядро.
 */
export async function installCoreBoardStub(page, mode = {}) {
  const state = { cards: mode.related ? relatedCards() : boardCards(), moves: [] };
  await page.route(CORE_ROUTES, async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace(/^\/api\/core/, '');
    if (path === '/board') {
      if (mode.delayMs) await new Promise((r) => setTimeout(r, mode.delayMs));
      if (mode.fail) {
        return route.fulfill({
          status: 501,
          json: { error: 'board is not wired', code: 'board-unwired' },
        });
      }
      return route.fulfill({
        json: {
          cards: state.cards,
          entries: [],
          limits: LIMITS,
          ...(mode.configIssues ? { configIssues: mode.configIssues } : {}),
        },
      });
    }
    if (path === '/board/move' && request.method() === 'POST') {
      const body = request.postDataJSON();
      state.moves.push(body);
      const target = state.cards.find((c) => c.id === (body.entryId ?? body.taskId));
      // Режим `related`: `merge` складывает отмеченные записи в цель либо отказывает прозой ядра
      // (`mode.mergeRefusal` — запись успела уйти в очередь), тем же телом, что `board-move.ts`.
      if (body.to === 'merge' && target?.moves.includes('merge')) {
        if (state.mergeRefusal ?? mode.mergeRefusal) {
          return route.fulfill({
            status: 409,
            json: {
              error: 'Ход доски не разрешён',
              code: 'move-not-allowed',
              allowed: target.moves,
              reason: MERGE_REFUSAL_REASON,
            },
          });
        }
        const folded = new Set(body.entryIds ?? []);
        state.cards = state.cards.filter((c) => !folded.has(c.id));
        target.related = (target.related ?? []).filter((h) => !folded.has(h.entryId));
        return route.fulfill({ json: { entries: [], replayed: false } });
      }
      if (!target || target.id === BOARD_IDS.stale || !target.moves.includes(body.to)) {
        // Тело `board-move.ts`: общее `error` по-русски, причина `moves.ts` — английской прозой.
        return route.fulfill({
          status: 409,
          json: {
            error: 'Ход доски не разрешён',
            code: 'move-not-allowed',
            allowed: ['restore'],
            reason: MOVE_REFUSAL_REASON,
          },
        });
      }
      if (body.to === 'queue') {
        Object.assign(target, {
          column: 'queue',
          state: 'queued',
          rank: 2,
          moves: ['inbox', 'rejected'],
        });
      }
      return route.fulfill({ json: { entries: [], replayed: false } });
    }
    if (path === '/nonce') {
      return route.fulfill({ json: { nonce: 'qa-board-nonce', expiresAt: Date.now() + 60_000 } });
    }
    if (path === '/tasks') {
      const tasks = state.cards
        .filter((c) => c.kind === 'task')
        .map((c, i) => ({
          taskId: c.taskId,
          live: c.column !== 'closed',
          seq: i + 1,
          state: c.state,
          ended: null,
          title: c.title,
          attention: null,
        }));
      return route.fulfill({ json: { tasks } });
    }
    const task = /^\/tasks\/([^/]+)(\/.*)?$/.exec(path);
    if (task?.[2]?.startsWith('/events')) {
      return route.fulfill({ status: 200, contentType: 'text/event-stream', body: '' });
    }
    if (task && !task[2]) {
      return route.fulfill({
        json: { task: null, live: true, view: { ...CORE_STUB_VIEW, taskId: task[1] } },
      });
    }
    return route.fallback();
  });
  await installLegacyGroupsStub(page, {
    runs: [
      {
        parentChatId: LEGACY_CHAT,
        projectPath: 'C:/work/shop',
        createdAt: '2026-10-30T10:00:00.000Z',
        state: 'cancelled',
        groups: [{ title: 'Прежняя группа A', branch: 'feat/legacy-a', status: 'started' }],
      },
    ],
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
    await page.waitForTimeout(200);
    await page.screenshot({ path: join(SHOTS, `${name}-${theme}_${TAG}.png`) });
  }
  await page.evaluate(() => {
    document.documentElement.dataset.theme = 'light';
  });
}

async function newPage(browser, mode) {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  page.errors = [];
  page.on('pageerror', (e) => page.errors.push(e.message));
  await bypassOnboarding(page);
  const state = await installCoreBoardStub(page, mode);
  return { page, state };
}

const countOf = (page, column) =>
  page
    .locator(`[data-board-columns] [data-board-column="${column}"]`)
    .first()
    .getAttribute('data-board-column-count');

async function main() {
  const browser = await chromium.launch();
  try {
    const { page, state } = await newPage(browser);

    // 1. Доска по умолчанию, счёт колонок и «ждёт вас» — из ответа ядра.
    await page.goto(`${BASE}/core`, { waitUntil: 'domcontentloaded' });
    const board = page.locator('[data-core-board]');
    await board.waitFor({ timeout: 20_000 });
    check(
      '/core открывается доской',
      (await page.locator('[data-core-view="board"]').count()) === 1,
    );
    const counts = {};
    for (const c of ['inbox', 'queue', 'work', 'waiting', 'review', 'mr']) {
      counts[c] = await countOf(page, c);
    }
    check(
      'счёт колонок = ответ ядра (входящие 1, очередь 1, работа 2, ждёт 1, ревью 0, MR 1)',
      JSON.stringify(counts) ===
        JSON.stringify({ inbox: '1', queue: '1', work: '2', waiting: '1', review: '0', mr: '1' }),
      JSON.stringify(counts),
    );
    check(
      'чип «Ждёт вас» = 1 (флаг waiting), а не сумма вопросов (5)',
      (await page.locator('[data-board-filter="waiting"]').getAttribute('data-board-waiting')) ===
        '1',
    );
    check(
      'неблокирующие вопросы — значок на карточке в своей колонке',
      (await page
        .locator(`[data-board-card="${BOARD_IDS.stale}"][data-board-card-column="work"]`)
        .locator('[data-board-card-questions="3"]')
        .count()) === 1,
    );
    check(
      'закрытая карточка не стоит в колонках стадий',
      (await page
        .locator(`[data-board-columns] [data-board-card="${BOARD_IDS.closed}"]`)
        .count()) === 0,
    );
    await shoot(page, 'board');

    // 2. Окно записи: «нет данных», ровно разрешённые ходы, ход в очередь.
    await page.locator(`[data-board-card="${BOARD_IDS.inbox}"]`).click();
    const modal = page.locator(`[data-card-modal="${BOARD_IDS.inbox}"]`);
    await modal.waitFor({ timeout: 10_000 });
    const absent = [];
    for (const fact of ['spend', 'agents', 'progress']) {
      const cell = modal.locator(`[data-card-fact="${fact}"]`);
      absent.push(
        (await cell.getAttribute('data-card-fact-absent')) !== null &&
          (await cell.innerText()).includes('нет данных'),
      );
    }
    check('у записи расход, агенты и ход — «нет данных», не 0', absent.every(Boolean), `${absent}`);
    const shown = await modal
      .locator('[data-card-move]')
      .evaluateAll((els) => els.map((el) => el.getAttribute('data-card-move')).sort());
    check(
      'кнопки ходов — ровно разрешённые ядром (queue, rejected)',
      JSON.stringify(shown) === JSON.stringify(['queue', 'rejected']),
      shown.join(','),
    );
    await shoot(page, 'board-entry-modal');
    const reread = page.waitForResponse(
      (r) => r.request().method() === 'GET' && /\/api\/core\/board$/.test(r.url()),
      { timeout: 10_000 },
    );
    await modal.locator('[data-card-move="queue"]').click();
    await reread.catch(() => undefined);
    const sent = state.moves.at(-1) ?? {};
    check(
      'ход ушёл в ядро телом {cmdId, entryId, to: queue, proof}',
      sent.entryId === BOARD_IDS.inbox &&
        sent.to === 'queue' &&
        typeof sent.cmdId === 'string' &&
        sent.proof?.nonce === 'qa-board-nonce' &&
        typeof sent.proof?.page === 'string' &&
        !('taskId' in sent),
      JSON.stringify(sent),
    );
    await page
      .locator(`[data-board-card="${BOARD_IDS.inbox}"][data-board-card-column="queue"]`)
      .waitFor({ timeout: 10_000 })
      .catch(() => undefined);
    check(
      'после хода доска перечитана: запись в «Очереди» (очередь 2, входящие 0)',
      (await countOf(page, 'queue')) === '2' && (await countOf(page, 'inbox')) === '0',
      `${await countOf(page, 'queue')} / ${await countOf(page, 'inbox')}`,
    );
    await page.keyboard.press('Escape');

    // 3. Отказ хода — причина и «Сейчас можно».
    await page.locator(`[data-board-card="${BOARD_IDS.stale}"]`).click();
    const stale = page.locator(`[data-card-modal="${BOARD_IDS.stale}"]`);
    await stale.waitFor({ timeout: 10_000 });
    await stale.locator('[data-card-move="rejected"]').click();
    const refused = stale.locator('[data-card-move-refused]');
    await refused.waitFor({ timeout: 10_000 }).catch(() => undefined);
    const refusedText = (await refused.innerText().catch(() => '')).trim();
    check(
      'отказ 409 показан причиной ядра и списком «Сейчас можно: Вернуть»',
      (await refused.getAttribute('data-card-move-refused').catch(() => null)) ===
        'move-not-allowed' &&
        refusedText.includes('«отклонена»') &&
        (
          await stale
            .locator('[data-card-move-allowed]')
            .innerText()
            .catch(() => '')
        ).includes('Вернуть'),
      refusedText,
    );
    check(
      'отказ хода по-русски: без английской прозы ядра и без общего «Ход доски не разрешён»',
      !/is not allowed|Ход доски не разрешён/.test(refusedText),
      refusedText,
    );
    check(
      'проза ядра — подсказкой отказа хода',
      (await refused
        .locator('[data-card-move-reason]')
        .getAttribute('title')
        .catch(() => null)) === MOVE_REFUSAL_REASON,
    );
    await page.waitForTimeout(600);
    const moveToasts = await page
      .locator('[data-toast-host]')
      .getByText(/Ход доски не разрешён|Ход не принят|is not allowed/)
      .count();
    check('отказ хода без копии общим тостом', moveToasts === 0, `тостов ${moveToasts}`);
    await page.keyboard.press('Escape');

    // 4. Окно задачи на стадии MR.
    await page.locator(`[data-board-card="${BOARD_IDS.mr}"]`).click();
    const mr = page.locator(`[data-card-modal="${BOARD_IDS.mr}"]`);
    await mr.waitFor({ timeout: 10_000 });
    check(
      'в окне задачи — название MR и ссылка на него',
      (await mr
        .locator('[data-card-mr-title]')
        .innerText()
        .catch(() => '')) === BOARD_MR_TITLE &&
        (await mr.locator('[data-card-mr="42"]').count()) === 1,
      await mr.innerText(),
    );
    check(
      'у задачи есть «Открыть ленту»',
      (await page.locator('[data-card-open-full]').count()) === 1,
    );
    await shoot(page, 'board-task-modal');
    await page.keyboard.press('Escape');

    // 5. «Список» рядом с доской.
    await page.locator('[data-core-view-option="list"]').click();
    await page
      .locator('[data-core-task-list]')
      .waitFor({ timeout: 10_000 })
      .catch(() => undefined);
    check(
      '«Список» показывает задачи ядра',
      (await page
        .locator('[data-core-view="list"] [data-core-task-list] [data-core-task]')
        .count()) === 5,
      await page.locator('[data-core-tasks-page]').innerText(),
    );

    // 6. `/groups` → полосы групп; «Закрытые» с прежними запусками.
    await page.goto(`${BASE}/groups?tab=global`, { waitUntil: 'domcontentloaded' });
    await board.waitFor({ timeout: 20_000 });
    const url = new URL(page.url());
    check(
      '/groups ведёт на доску полосами групп',
      url.pathname === '/core' &&
        url.searchParams.get('view') === 'board' &&
        url.searchParams.get('lane') === 'group' &&
        (await board.getAttribute('data-board-lane')) === 'group',
      page.url(),
    );
    check(
      'полоса группы ядра — две её задачи',
      (await page
        .locator(`[data-board-lane-group="${BOARD_GROUP}"]`)
        .getAttribute('data-board-lane-count')) === '2',
    );
    // Число у «Группы» в меню — групп ядра в работе (полосы этой доски), а не прежних наборов
    // настроек: живой стенд показывал 11 при пустых полосах.
    const lanesShown = await page.locator('[data-board-lane-group]').count();
    const navGroups = (
      await page.locator('nav a[href*="lane=group"] [class*="navCount"]').allTextContents()
    ).join('');
    check(
      'у «Группы» в меню — число полос групп доски',
      lanesShown > 0 && navGroups === String(lanesShown),
      `меню «${navGroups}», полос ${lanesShown}`,
    );
    await shoot(page, 'board-lanes');
    await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
    const tile = page.locator('main a[href*="lane=group"]').first();
    await tile.waitFor({ timeout: 20_000 });
    await page
      .waitForFunction(
        () => /\d/.test(document.querySelector('main a[href*="lane=group"]')?.textContent ?? ''),
        undefined,
        { timeout: 15_000 },
      )
      .catch(() => undefined);
    const tileText = (await tile.innerText()).replace(/\s+/g, ' ').trim();
    check(
      'плитка «Группы» в сводке — то же число полос и подпись про группы ядра',
      tileText.match(/\d+/)?.[0] === String(lanesShown) && !/набор/i.test(tileText),
      tileText,
    );
    await tile.click();
    await board.waitFor({ timeout: 20_000 });
    await page.locator('[data-board-closed-toggle]').click();
    await page
      .locator(`[data-legacy-run="${LEGACY_CHAT}"]`)
      .waitFor({ timeout: 10_000 })
      .catch(() => undefined);
    check(
      '«Закрытые»: закрытая задача и прежний запуск группы без кнопок',
      (await page
        .locator(`[data-board-closed="open"] [data-board-card="${BOARD_IDS.closed}"]`)
        .count()) === 1 &&
        (await page.locator(`[data-legacy-run="${LEGACY_CHAT}"]`).count()) === 1 &&
        (await page.locator(`[data-legacy-run="${LEGACY_CHAT}"] button`).count()) === 0,
    );

    // 7. Шапка чата.
    await page.goto(`${BASE}/chat`, { waitUntil: 'domcontentloaded' });
    const chatBoard = page.locator('[data-chat-board]');
    await chatBoard.waitFor({ timeout: 20_000 }).catch(() => undefined);
    await page
      .locator('[data-chat-board][data-board-waiting]')
      .waitFor({ timeout: 10_000 })
      .catch(() => undefined);
    check(
      'в шапке чата «Доска · ждёт вас: 1» из ответа доски',
      (await chatBoard.getAttribute('data-board-waiting').catch(() => null)) === '1',
      await chatBoard.innerText().catch(() => '(кнопки нет)'),
    );
    await shoot(page, 'chat-header');
    await chatBoard.click();
    await page.waitForURL(/\/core/, { timeout: 10_000 }).catch(() => undefined);
    check('клик по «Доске» в чате ведёт на доску', new URL(page.url()).pathname === '/core');
    check('страница без ошибок', page.errors.length === 0, page.errors.join('\n'));
    await page.close();

    // 8. Вариация: доска не подключена (501).
    const { page: down } = await newPage(browser, { fail: true });
    await down.goto(`${BASE}/core`, { waitUntil: 'domcontentloaded' });
    const unavailable = down.getByText('Доска не отвечает');
    check(
      'доска 501 — «Доска не отвечает», без колонок',
      await unavailable
        .waitFor({ timeout: 15_000 })
        .then(async () => (await down.locator('[data-board-columns]').count()) === 0)
        .catch(() => false),
    );
    await down.goto(`${BASE}/chat`, { waitUntil: 'domcontentloaded' });
    await down
      .locator('[data-chat-board]')
      .waitFor({ timeout: 20_000 })
      .catch(() => undefined);
    await down.waitForTimeout(1500);
    check(
      'доска 501 — в чате «Доска» без числа (незнание — не ноль)',
      (await down.locator('[data-chat-board]').count()) === 1 &&
        (await down.locator('[data-chat-board]').getAttribute('data-board-waiting')) === null,
    );
    await down.close();

    // 9. Вариация: ответ доски задержан — скелет, не пустая доска.
    const { page: slow } = await newPage(browser, { delayMs: 2500 });
    await slow.goto(`${BASE}/core`, { waitUntil: 'domcontentloaded' });
    await slow.locator('[data-core-view-toggle]').waitFor({ timeout: 20_000 });
    await slow.waitForTimeout(800);
    check(
      'до ответа доски — ни пустой доски, ни «Доска не отвечает», ни колонок',
      (await slow.getByText('На доске пусто').count()) === 0 &&
        (await slow.getByText('Доска не отвечает').count()) === 0 &&
        (await slow.locator('[data-board-columns]').count()) === 0,
    );
    await slow.locator('[data-board-columns]').waitFor({ timeout: 10_000 });
    check('после ответа доска нарисована', (await countOf(slow, 'work')) === '2');
    await slow.close();

    // 10. Вариация: раздел `board` настройки негоден — ядро служит умолчаниями и называет жалобу.
    const reason = 'inWork: Invalid input';
    const { page: issues } = await newPage(browser, {
      configIssues: [{ section: 'board', reason }],
    });
    await issues.goto(`${BASE}/core`, { waitUntil: 'domcontentloaded' });
    await issues.locator('[data-board-columns]').waitFor({ timeout: 20_000 });
    const issueRow = issues.locator('[data-board-config-issues]');
    const issueText = (await issueRow.count()) ? await issueRow.innerText() : '(строки нет)';
    check(
      'негодный раздел board — доска говорит «действуют умолчания» и причину ядра',
      issueText.includes('умолчания') && issueText.includes(reason),
      issueText,
    );
    await shoot(issues, 'config-issues');
    await issues.close();

    // 11. Ядро стартовало запись, пока её окно открыто: окно идёт за задачей с тем же entryId.
    const { page: started, state: startedState } = await newPage(browser);
    await started.goto(`${BASE}/core`, { waitUntil: 'domcontentloaded' });
    await started.locator(`[data-board-card="${BOARD_IDS.inbox}"]`).click();
    await started.locator(`[data-card-modal="${BOARD_IDS.inbox}"]`).waitFor({ timeout: 10_000 });
    const startedTask = id(99);
    const at = startedState.cards.findIndex((c) => c.id === BOARD_IDS.inbox);
    startedState.cards[at] = {
      ...card('inbox', { column: 'work', state: 'running', startedAt: AT + 1 }),
      id: startedTask,
      taskId: startedTask,
      entryId: BOARD_IDS.inbox,
    };
    const followed = await started
      .locator(`[data-card-modal="${startedTask}"]`)
      .waitFor({ timeout: 12_000 })
      .then(() => true)
      .catch(() => false);
    check(
      'окно записи после старта показывает её задачу, а не закрывается',
      followed && (await started.locator('[role="dialog"]').count()) === 1,
      `modal: ${await started
        .locator('[data-card-modal]')
        .getAttribute('data-card-modal')
        .catch(() => '(закрыто)')}`,
    );
    await started.keyboard.press('Escape');

    // 12. Отбор группы, у которой не осталось открытых карточек, снимается своим чипом.
    const gone = '01900000-0000-7000-8000-00000000dead';
    await started.goto(`${BASE}/core?view=board&group=${gone}`, { waitUntil: 'domcontentloaded' });
    await started.locator('[data-board-columns]').waitFor({ timeout: 20_000 });
    const chip = started.locator(`[data-board-group-chip="${gone}"]`);
    const pressed =
      (await chip.count()) === 1 && (await chip.getAttribute('aria-pressed')) === 'true';
    if (pressed) await chip.click();
    await started
      .waitForURL((u) => !u.searchParams.has('group'), { timeout: 5_000 })
      .catch(() => undefined);
    check(
      'устаревший отбор группы виден нажатым чипом, нажатие снимает его — колонки снова полны',
      pressed &&
        (await countOf(started, 'work')) ===
          String(startedState.cards.filter((c) => c.column === 'work').length),
      `chip pressed: ${pressed}, url: ${started.url()}`,
    );
    await started.close();
  } finally {
    await browser.close();
  }
  console.log(bad === 0 ? '\nВсё сходится.' : `\nПровалов: ${bad}`);
  process.exit(bad === 0 ? 0 : 1);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main();
