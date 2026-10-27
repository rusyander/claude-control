/**
 * Список чатов в боковой панели: строки поменялись местами, а их число то же.
 *
 * Список виртуальный (с 40 строк), и высоту строки ему отдаёт `estimateSize`.
 * Замеры библиотеки пересчитываются при смене числа строк, а не при смене
 * порядка: пока число прежнее, строка держит высоту того, что раньше стояло
 * на её месте. Строка «Ещё 1» получает 100px (пустая дыра), переехавший
 * разговор — 32px (обрезан), заголовок группы — 100px.
 *
 * Два случая, в каждом число строк до и после одно и то же (проверяется, а не
 * предполагается: наибольший `data-index` при прокрутке до конца):
 *
 * - `finish` — идущий разговор X кончил работу и ушёл из «Сейчас работают» в
 *   «Сегодня». Прогон — запись в `/api/chat/active` (её читает опрос
 *   `startActivePoll`), поток прогона отдаёт пинг, а переподключения висят;
 *   конец — терминальный кадр `done` в открытый поток, как его шлёт сервер.
 * - `pin` — при одном уже закреплённом чате закрепили второй (кнопка-булавка
 *   в строке): он ушёл из «Сегодня» в «Закреплённые». `PUT …/pin` заглушка
 *   ведёт себя как сервер: хранит закрепление и отдаёт `pinnedAt` в списке.
 *
 * Данные: 49 разговоров — закреплённый корень; X; разделение «Пачка задач» с
 * простаивающей группой, поднятой в «Сейчас работают» меткой `inWork` (под ним
 * строка «Ещё 1»); 45 обычных за сегодня, вчера, неделю и раньше.
 *
 * Раскладка отрисованных строк (`[data-index]` внутри холста списка): высота
 * каждой — та, что нужна её виду (разговор 100, заголовок и «Ещё N» 32), а
 * сдвиг — сдвиг предыдущей плюс её высота (ни дыр, ни наездов).
 *
 * Список разговоров отдаётся после первого ответа `/api/chat/active`: первый
 * же показ списка уже идёт с прогоном X, а не переставляется на глазах (иначе
 * проверка ловила бы ту же ошибку на загрузке). Раскладка до перестановки
 * проверяется тем же правилом — она обязана быть верной. Записей к серверу
 * нет — любая не-GET, кроме закрепления, заглушена 501.
 *
 * Код выхода: 0 — раскладка верна в обоих случаях; 1 — неверна хотя бы в
 * одном (дефект списка); 2 — сценарий не сошёлся (число строк разное, строка
 * не переехала, раскладка неверна ещё до перестановки): это не вердикт о списке.
 * Вердикт печатается по каждому случаю отдельно.
 *
 * Запуск: `node tools/qa/check-chat-list-reorder.mjs` при поднятом фронте
 * (`APP_URL`, по умолчанию http://localhost:8888; `CHROMIUM_EXECUTABLE_PATH` —
 * свой браузер, если сборки Playwright нет в кэше).
 * `--shot <папка>` — снимок боковой панели после перестановки в каждом случае
 * (данные подменены целиком); `SHOTS=<папка>` — то же, как у соседних проверок.
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { bypassOnboarding } from './bypass-onboarding.mjs';

const BASE = process.env.APP_URL ?? 'http://localhost:8888';
const shotAt = process.argv.indexOf('--shot');
const SHOT_DIR = shotAt >= 0 ? process.argv[shotAt + 1] : process.env.SHOTS;
if (shotAt >= 0 && (!SHOT_DIR || SHOT_DIR.startsWith('--'))) {
  console.error('--shot требует папку: --shot <папка>');
  process.exit(2);
}
if (SHOT_DIR) mkdirSync(SHOT_DIR, { recursive: true });

// Высоты строк — те же, что в ChatList.constants.ts (разговор, заголовок, «Ещё N»).
const NEED = { chat: 100, header: 32, more: 32, inactive: 32 };
const HEADERS = ['Закреплённые', 'Сейчас работают', 'Сегодня', 'Вчера', 'На этой неделе', 'Раньше'];
const STORAGE_KEY = 'agentdeck.chatList.expanded';
const SETTLE_WAIT_MS = 20_000;
// Якоря холста: текст, по которому находим строки именно этого списка.
const ANCHORS = ['Закреплённый корень', 'Обычный чат'];

const PROJECT = { name: 'QA перестановка', path: 'C:/qa-reorder-project' };
const NOW = Date.now();
const DAY = 86_400_000;
const startOfToday = new Date();
startOfToday.setHours(0, 0, 0, 0);

const chat = (id, title, extra = {}) => ({
  id,
  title,
  project: PROJECT.name,
  projectPath: extra.copy ? `${PROJECT.path}-worktrees/${extra.copy}` : PROJECT.path,
  isSandbox: false,
  messageCount: 3,
  createdAt: new Date(NOW - 3 * DAY).toISOString(),
  updatedAt: new Date(extra.at ?? NOW - 60_000).toISOString(),
  preview: '',
  ...(extra.parentId ? { parentId: extra.parentId } : {}),
  ...(extra.inWork ? { inWork: true } : {}),
  ...(extra.copy ? { branch: `agent/${extra.copy}` } : {}),
  ...(extra.pinnedAt ? { pinnedAt: extra.pinnedAt } : {}),
});

const X = 'qa-reorder-x';
const P = 'qa-reorder-parent';
const PINNED = 'qa-reorder-pinned';
const TARGET = 'qa-reorder-o0';
const TITLES = {
  pinned: 'Закреплённый корень',
  x: 'Идущий разговор X',
  parent: 'Пачка задач',
  child: 'Группа «Простаивает» (в работе)',
  target: 'Обычный чат 01',
};
// Порядок по свежести: X новее родителя, поэтому в «Сейчас работают» он стоит
// ВЫШЕ ветви, а после ухода в «Сегодня» — выше всех обычных за сегодня.
const ordinary = Array.from({ length: 45 }, (_, i) => {
  let at;
  if (i < 20) at = NOW - 10_000 - i * 1000;
  else if (i < 30) at = startOfToday.getTime() - (i - 19) * 3_600_000;
  else if (i < 35) at = startOfToday.getTime() - (i - 28) * DAY;
  else at = startOfToday.getTime() - (10 + i - 35) * DAY;
  return chat(`qa-reorder-o${i}`, `Обычный чат ${String(i + 1).padStart(2, '0')}`, { at });
});
const CHATS = [
  chat(PINNED, TITLES.pinned, {
    at: startOfToday.getTime() - 3 * DAY,
    pinnedAt: new Date(NOW - 3_600_000).toISOString(),
  }),
  chat(X, TITLES.x, { at: NOW - 1000 }),
  chat(P, TITLES.parent, { at: NOW - 2000 }),
  chat('qa-reorder-child', TITLES.child, {
    parentId: P,
    inWork: true,
    copy: 'idle',
    at: NOW - 3000,
  }),
  ...ordinary,
];

// `CHROMIUM_EXECUTABLE_PATH` — запасной браузер, когда нужной сборки Playwright нет в кэше.
const browser = await chromium.launch(
  process.env.CHROMIUM_EXECUTABLE_PATH
    ? { executablePath: process.env.CHROMIUM_EXECUTABLE_PATH }
    : {},
);

/** Сценарий не сошёлся — вердикта о списке нет. */
class ScenarioError extends Error {}

/**
 * Страница со всеми заглушками. `running` — кого сервер называет идущим;
 * `pins` — что закреплено (начальные закрепления берутся из данных).
 */
async function openPage(running) {
  const state = { running, finished: false, pins: new Map(), streamHits: 0, pending: [] };
  for (const item of CHATS) if (item.pinnedAt) state.pins.set(item.id, item.pinnedAt);
  const listed = () =>
    CHATS.map((item) =>
      state.pins.has(item.id) ? { ...item, pinnedAt: state.pins.get(item.id) } : item,
    );
  let activeAnswered;
  const activeSeen = new Promise((resolve) => {
    activeAnswered = resolve;
  });

  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.setDefaultTimeout(8000);
  await bypassOnboarding(page);
  await page.route('**/api/**', (route) =>
    route.request().method() === 'GET'
      ? route.fallback()
      : route.fulfill({ status: 501, json: { error: 'qa: запись закрыта' } }),
  );
  await page.route('**/api/chats', async (route) => {
    await activeSeen;
    await new Promise((resolve) => setTimeout(resolve, 400));
    return route.fulfill({ json: listed() });
  });
  await page.route('**/api/chats/*/pin', (route) => {
    const request = route.request();
    if (request.method() !== 'PUT') return route.fallback();
    const id = decodeURIComponent(new URL(request.url()).pathname.split('/').at(-2) ?? '');
    const pinned = request.postDataJSON()?.pinned;
    if (pinned) state.pins.set(id, new Date().toISOString());
    else state.pins.delete(id);
    return route.fulfill({ json: { id, pinned } });
  });
  await page.route('**/api/chats/projects*', (route) =>
    route.fulfill({
      json: [
        {
          path: PROJECT.path,
          name: PROJECT.name,
          exists: true,
          lastActivity: new Date(NOW).toISOString(),
          chats: [],
        },
      ],
    }),
  );
  await page.route('**/api/chat/active', async (route) => {
    await route.fulfill({
      json: state.running.map((chatId) => ({ chatId, seq: 0, status: 'running' })),
    });
    activeAnswered();
  });

  // Поток прогона X: первый ответ — пинг, переподключения висят, пока прогон «идёт».
  // Конец прогона — терминальный кадр `done` в поток, как его шлёт сервер: пока поток
  // открыт, опрос `/api/chat/active` прогон не трогает, закрывает его только поток.
  const doneFrame = `data: ${JSON.stringify({ kind: 'done', seq: 1, costUsd: 0, sessionId: X })}\n\n`;
  const sendDone = (route) =>
    route
      .fulfill({ status: 200, headers: { 'content-type': 'text/event-stream' }, body: doneFrame })
      .catch(() => undefined);
  await page.route(`**/api/chat/${X}/stream*`, (route) => {
    state.streamHits += 1;
    if (state.finished) return sendDone(route);
    if (state.streamHits === 1) {
      return route.fulfill({
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
        body: ': ping\n\n',
      });
    }
    state.pending.push(route);
  });
  /** Прогон X кончился: сервер больше не называет его, а открытый поток получает `done`. */
  state.finishRun = async () => {
    state.finished = true;
    state.running = [];
    await Promise.all(state.pending.splice(0).map(sendDone));
  };
  return { page, state };
}

const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

async function openProject(page) {
  const rowOf = (title) => page.getByRole('button', { name: new RegExp(escape(title)) }).first();
  await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
  await page.evaluate((key) => localStorage.removeItem(key), STORAGE_KEY);
  await page.goto(`${BASE}/chat`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('nav');
  await page.waitForTimeout(1200);
  // Вкладка проекта помнится через перезагрузку: тогда список уже его.
  const already = await rowOf(TITLES.pinned)
    .waitFor({ timeout: 3000 })
    .then(() => true)
    .catch(() => false);
  if (!already) {
    await page.getByRole('tab', { name: 'Проекты' }).click({ timeout: 15_000 });
    await page.waitForTimeout(600);
    await page
      .getByRole('button', { name: new RegExp(escape(PROJECT.name)) })
      .first()
      .click();
  }
  await rowOf(TITLES.pinned).waitFor({ timeout: 20_000 });
  await page.waitForTimeout(600);
}

/**
 * Отрисованные строки холста списка. Холст — родитель строк `[data-index]`,
 * в которых стоит один из якорей: на странице могут быть и другие виртуальные
 * списки.
 */
const readRows = (page) =>
  page.evaluate(
    ({ anchors, headers }) => {
      const all = [...document.querySelectorAll('[data-index]')];
      const anchor = all.find((node) => anchors.some((text) => node.textContent.includes(text)));
      if (!anchor) return { rows: [], found: false };
      const canvas = anchor.parentElement;
      const kindOf = (node) => {
        if (node.querySelector('[data-chat-more]')) return 'more';
        if (node.querySelector('[data-chat-lost-parent], button')) return 'chat';
        const text = node.textContent.trim();
        if (text === 'Неактивно') return 'inactive';
        return headers.includes(text) ? 'header' : 'unknown';
      };
      const rows = [...canvas.children]
        .filter((node) => node.hasAttribute('data-index'))
        .map((node) => ({
          index: Number(node.getAttribute('data-index')),
          height: parseFloat(node.style.height),
          top: Number(/translateY\((-?[\d.]+)px\)/.exec(node.style.transform)?.[1] ?? Number.NaN),
          kind: kindOf(node),
          label: (node.textContent.trim().replace(/\s+/g, ' ') || '—').slice(0, 44),
        }));
      return { rows, found: true };
    },
    { anchors: ANCHORS, headers: HEADERS },
  );

/**
 * Число строк списка: прокрутить окно до конца и взять наибольший `data-index`.
 * Отрисованные строки — только окно, поэтому по ним одним число не узнать.
 * Прокрутку возвращает наверх: раскладка сверху — то, что проверяется.
 */
async function countRows(page) {
  const scrollTo = (toBottom) =>
    page.evaluate(
      ({ anchors, bottom }) => {
        const anchor = [...document.querySelectorAll('[data-index]')].find((node) =>
          anchors.some((text) => node.textContent.includes(text)),
        );
        const viewport = anchor?.parentElement?.parentElement;
        if (viewport) viewport.scrollTop = bottom ? viewport.scrollHeight : 0;
      },
      { anchors: ANCHORS, bottom: toBottom },
    );
  await scrollTo(true);
  await page.waitForTimeout(500);
  const { rows } = await readRows(page);
  const total = rows.length === 0 ? 0 : Math.max(...rows.map((row) => row.index)) + 1;
  await scrollTo(false);
  await page.waitForTimeout(500);
  return total;
}

const indexOfText = (rows, text) => rows.find((row) => row.label.includes(text))?.index ?? -1;

/** Что не так с раскладкой: высота не по виду, дыра или наезд между соседями. */
function layoutProblems(rows) {
  const problems = [];
  const sorted = [...rows].sort((a, b) => a.index - b.index);
  sorted.forEach((row, at) => {
    const need = NEED[row.kind];
    if (need === undefined) {
      problems.push(`строка ${row.index} «${row.label}»: вид не опознан`);
    } else if (row.height !== need) {
      problems.push(
        `строка ${row.index} (${row.kind} «${row.label}»): высота ${row.height}, нужна ${need}`,
      );
    }
    const prev = sorted[at - 1];
    if (!prev) {
      if (row.index === 0 && row.top !== 0) {
        problems.push(`строка 0: сдвиг ${row.top}, должен быть 0`);
      }
      return;
    }
    if (row.index !== prev.index + 1) {
      problems.push(`между строками ${prev.index} и ${row.index} нет отрисованных строк`);
      return;
    }
    const expected = prev.top + prev.height;
    if (Math.abs(row.top - expected) > 0.5) {
      const kind = row.top > expected ? 'дыра' : 'наезд';
      problems.push(
        `строка ${row.index} «${row.label}»: сдвиг ${row.top}, ждали ${expected} (${kind} ${Math.abs(row.top - expected)}px)`,
      );
    }
  });
  return problems;
}

const table = (rows) =>
  [...rows]
    .sort((a, b) => a.index - b.index)
    .map((row) => {
      const need = NEED[row.kind];
      const mark = row.height === need ? ' ' : '×';
      return `  ${mark} ${String(row.index).padStart(2)}  ${row.kind.padEnd(6)} высота ${String(row.height).padStart(3)} (нужна ${need ?? '?'})  сдвиг ${String(row.top).padStart(4)}  «${row.label}»`;
    })
    .join('\n');

/** Снимок боковой панели: четыре предка строки списка — холст, окно, блок, панель. */
async function shotPanel(page, name) {
  if (!SHOT_DIR) return;
  const panel = await page.evaluateHandle(
    ({ anchors }) =>
      [...document.querySelectorAll('[data-index]')].find((node) =>
        anchors.some((text) => node.textContent.includes(text)),
      )?.parentElement?.parentElement?.parentElement?.parentElement,
    { anchors: ANCHORS },
  );
  const path = join(SHOT_DIR, name);
  const element = panel.asElement();
  if (element) await element.screenshot({ path });
  else await page.screenshot({ path });
  console.log(`  снимок: ${path}`);
}

/**
 * Случай: `precondition` — что должно стоять до перестановки (текст ошибки или
 * ничего), `trigger` — что её вызывает, `moved` — переехала ли строка,
 * `describe` — как назвать переезд в вердикте.
 */
const CASES = [
  {
    name: 'finish',
    title: 'идущий X кончил работу и ушёл из «Сейчас работают» в «Сегодня»',
    running: [X],
    shot: 'chat-list-after-finish.png',
    precondition: (rows) => {
      const header = indexOfText(rows, 'Сейчас работают');
      const today = indexOfText(rows, 'Сегодня');
      const at = indexOfText(rows, TITLES.x);
      if (!(header >= 0 && at > header && (today < 0 || at < today))) {
        return `до перестановки X не в «Сейчас работают»: заголовок ${header}, X ${at}, «Сегодня» ${today}`;
      }
      return undefined;
    },
    trigger: async ({ state }) => state.finishRun(),
    moved: (rows) => {
      const today = indexOfText(rows, 'Сегодня');
      const at = indexOfText(rows, TITLES.x);
      return today >= 0 && at > today;
    },
    where: (rows) => indexOfText(rows, TITLES.x),
    subject: 'X',
  },
  {
    name: 'pin',
    title:
      'при одном закреплённом закрепили второй: «Обычный чат 01» ушёл из «Сегодня» в «Закреплённые»',
    running: [],
    shot: 'chat-list-after-pin.png',
    precondition: (rows) => {
      const pinnedHeader = indexOfText(rows, 'Закреплённые');
      const today = indexOfText(rows, 'Сегодня');
      const at = indexOfText(rows, TITLES.target);
      if (!(pinnedHeader === 0 && today >= 0 && at > today)) {
        return `до закрепления: заголовок «Закреплённые» ${pinnedHeader}, «Сегодня» ${today}, «${TITLES.target}» ${at}`;
      }
      return undefined;
    },
    trigger: async ({ page }) => {
      await page
        .getByRole('button', { name: new RegExp(escape(TITLES.target)) })
        .first()
        .hover();
      await page.locator(`[data-chat-pin="${TARGET}"]`).click();
    },
    moved: (rows) => {
      const header = indexOfText(rows, 'Сейчас работают');
      const at = indexOfText(rows, TITLES.target);
      return header >= 0 && at > 0 && at < header;
    },
    where: (rows) => indexOfText(rows, TITLES.target),
    subject: TITLES.target,
  },
];

/** Один случай целиком: вернуть вердикт, не выходя из процесса. */
async function runCase(scenario) {
  const { page, state } = await openPage(scenario.running);
  try {
    await openProject(page);

    const before = await readRows(page);
    if (!before.found) throw new ScenarioError('список не отрисован: нет ни одной строки с якорем');
    const broken = scenario.precondition(before.rows);
    if (broken) throw new ScenarioError(`${broken}\n${table(before.rows)}`);
    if (indexOfText(before.rows, 'Ещё 1') < 0) {
      throw new ScenarioError(`нет строки «Ещё 1» под разделением\n${table(before.rows)}`);
    }
    const beforeProblems = layoutProblems(before.rows);
    if (beforeProblems.length > 0) {
      throw new ScenarioError(
        `раскладка неверна ещё до перестановки (первый показ):\n  ${beforeProblems.join('\n  ')}\n${table(before.rows)}`,
      );
    }
    const totalBefore = await countRows(page);
    if (totalBefore < 40) {
      throw new ScenarioError(`строк ${totalBefore}: список не виртуальный (порог 40)`);
    }
    const whereBefore = scenario.where(before.rows);

    await scenario.trigger({ page, state });

    const deadline = Date.now() + SETTLE_WAIT_MS;
    let after = before;
    while (Date.now() < deadline) {
      await page.waitForTimeout(300);
      after = await readRows(page);
      if (scenario.moved(after.rows)) break;
    }
    if (!scenario.moved(after.rows)) {
      throw new ScenarioError(
        `за ${SETTLE_WAIT_MS / 1000}с строка «${scenario.subject}» не переехала\n${table(after.rows)}`,
      );
    }
    await page.waitForTimeout(600);
    const totalAfter = await countRows(page);
    after = await readRows(page);
    await shotPanel(page, scenario.shot);

    if (totalBefore !== totalAfter) {
      throw new ScenarioError(`число строк изменилось: было ${totalBefore}, стало ${totalAfter}`);
    }

    const whereAfter = scenario.where(after.rows);
    const problems = layoutProblems(after.rows);
    return {
      ok: problems.length === 0,
      text:
        problems.length === 0
          ? `ок: [${scenario.name}] при тех же ${totalAfter} строках раскладка верна (${after.rows.length} отрисовано, «${scenario.subject}»: строка ${whereBefore} → ${whereAfter})`
          : [
              `ПЛОХО × [${scenario.name}] «${scenario.subject}»: строка ${whereBefore} → ${whereAfter}, строк ${totalBefore} → ${totalAfter}, раскладка неверна:`,
              ...problems.map((problem) => `  ${problem}`),
              `раскладка после перестановки:\n${table(after.rows)}`,
            ].join('\n'),
    };
  } catch (error) {
    if (error instanceof ScenarioError) {
      return { ok: false, scenario: true, text: `СЦЕНАРИЙ × [${scenario.name}] ${error.message}` };
    }
    throw error;
  } finally {
    await page.close();
  }
}

const verdicts = [];
try {
  for (const scenario of CASES) {
    console.log(`── ${scenario.name}: ${scenario.title}`);
    const verdict = await runCase(scenario);
    verdicts.push(verdict);
    console.log(verdict.text);
  }
} finally {
  await browser.close();
}
if (verdicts.some((verdict) => verdict.scenario)) process.exit(2);
process.exit(verdicts.every((verdict) => verdict.ok) ? 0 : 1);
