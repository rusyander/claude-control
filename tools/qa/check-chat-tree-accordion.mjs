/**
 * Дерево чатов в боковой панели (G1, владелец 05.10.2026): под родителем
 * разделения видны только дети с живым прогоном (зелёная, жёлтая, красная
 * точка), остальные дети ветви свёрнуты в одну строку-гармошку «Ещё N» на ветвь.
 * Метка «группа в работе» без прогона ребёнка на виду не держит (владелец 07.10).
 *
 * - Родитель «Пачка задач»: у одной группы идёт прогон (видна), «Отчёты» на
 *   стадии без прогона, «Экспорт» стоит, одна снята перезапуском (свёрнуты:
 *   «Ещё 3»). Родитель «Ночная пачка» без
 *   идущих детей: гармошка держит всех («Ещё 2»).
 * - Гармошка — кнопка с aria-expanded, открывается с клавиатуры (Enter,
 *   пробел); внутри — стоящие дети, затем разделитель «Неактивно» и снятые.
 * - Раскрытое помнится на родителя через перезагрузку (localStorage); битое
 *   значение в хранилище — свёрнуто, без падения страницы.
 * - Пока идёт поиск, гармошек нет: найденное видно, даже если ветвь свёрнута.
 * - Высота строки-гармошки — та, под которую считает виртуальный список:
 *   соседние строки не наезжают друг на друга.
 *
 * Данные подменены целиком (список чатов, проекты, прогоны: идущий прогон — запись
 * в `/api/chat/active` и поток, который висит открытым); записей к серверу
 * нет — любая не-GET заглушена 501.
 *
 * Запуск: `node tools/qa/check-chat-tree-accordion.mjs` при поднятом фронте
 * (`APP_URL`, по умолчанию http://localhost:8888); `SHOTS=<папка>` — снимки,
 * `PHASE=BEFORE|AFTER` — суффикс их имён.
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { bypassOnboarding } from './bypass-onboarding.mjs';

const BASE = process.env.APP_URL ?? 'http://localhost:8888';
const SHOTS = process.env.SHOTS;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const PROJECT = { name: 'QA гармошка', path: 'C:/qa-accordion-project' };
const STORAGE_KEY = 'agentdeck.chatList.expanded';
const NOW = Date.now();

const chat = (id, title, extra = {}) => ({
  id,
  title,
  project: PROJECT.name,
  projectPath: extra.copy ? `${PROJECT.path}-worktrees/${extra.copy}` : PROJECT.path,
  isSandbox: false,
  messageCount: 3,
  createdAt: new Date(NOW - 3_600_000).toISOString(),
  updatedAt: new Date(NOW - (extra.ago ?? 60) * 60_000).toISOString(),
  preview: '',
  ...(extra.parentId ? { parentId: extra.parentId } : {}),
  ...(extra.inWork ? { inWork: true } : {}),
  ...(extra.retired ? { retired: true } : {}),
  ...(extra.copy ? { branch: `agent/${extra.copy}` } : {}),
});

const P = 'qa-acc-parent';
const Q = 'qa-acc-night';
const TITLES = {
  parent: 'Пачка задач',
  running: 'Группа «Авторизация» (идёт)',
  idle1: 'Группа «Отчёты» (стадия без прогона)',
  idle2: 'Группа «Экспорт» (стоит)',
  retired: 'Группа «Старый импорт» (снята)',
  night: 'Ночная пачка',
  night1: 'Ночь: группа «Логи»',
  night2: 'Ночь: группа «Метрики»',
  loose: 'Отдельный разговор',
};
const CHATS = [
  chat(P, TITLES.parent, { inWork: true, ago: 5 }),
  chat('qa-acc-run', TITLES.running, { parentId: P, inWork: true, copy: 'auth', ago: 6 }),
  chat('qa-acc-idle1', TITLES.idle1, { parentId: P, inWork: true, copy: 'reports', ago: 7 }),
  chat('qa-acc-idle2', TITLES.idle2, { parentId: P, copy: 'export', ago: 8 }),
  chat('qa-acc-old', TITLES.retired, { parentId: P, retired: true, copy: 'import', ago: 9 }),
  chat(Q, TITLES.night, { ago: 30 }),
  chat('qa-acc-n1', TITLES.night1, { parentId: Q, copy: 'logs', ago: 31 }),
  chat('qa-acc-n2', TITLES.night2, { parentId: Q, copy: 'metrics', ago: 32 }),
  chat('qa-acc-loose', TITLES.loose, { ago: 40 }),
];

const rows = [];
const check = (ok, text, detail = '') => {
  rows.push({ ok, text });
  console.log(`${ok ? 'ок    ' : 'ПЛОХО ×'} ${text}${detail ? ` — ${detail}` : ''}`);
  return ok;
};

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
// Отсутствующий элемент — ответ «нет», а не полминуты ожидания на каждой строке.
page.setDefaultTimeout(4000);
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
await bypassOnboarding(page);
await page.route('**/api/**', (route) =>
  route.request().method() === 'GET'
    ? route.fallback()
    : route.fulfill({ status: 501, json: { error: 'qa: запись закрыта' } }),
);
await page.route('**/api/chats', (route) => route.fulfill({ json: CHATS }));
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
// Идущий прогон есть только у «Авторизации»: сервер называет его, первый поток отдаёт
// пинг, переподключения висят — прогон честно остаётся идущим всю проверку.
await page.route('**/api/chat/active', (route) =>
  route.fulfill({ json: [{ chatId: 'qa-acc-run', seq: 0, status: 'running' }] }),
);
let runStreamHits = 0;
await page.route('**/api/chat/qa-acc-run/stream*', (route) => {
  runStreamHits += 1;
  if (runStreamHits > 1) return;
  return route.fulfill({
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
    body: ': ping\n\n',
  });
});

const shot = async (name) => {
  const suffix = process.env.PHASE ? `_${process.env.PHASE}` : '';
  if (SHOTS) await page.screenshot({ path: join(SHOTS, `${name}${suffix}.png`) });
};
const rowOf = (title) => page.getByRole('button', { name: new RegExp(escape(title)) }).first();
function escape(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
const visible = (title) => rowOf(title).isVisible();
const more = (parent) => page.locator(`[data-chat-more="${parent}"]`);
const boxOf = async (locator) =>
  (await locator.count()) > 0 && (await locator.isVisible()) ? locator.boundingBox() : null;
const topOf = async (locator) => (await boxOf(locator))?.y ?? -1;

const openProject = async () => {
  await page.goto(`${BASE}/chat`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('nav');
  await page.waitForTimeout(1200);
  // Вкладка проекта помнится через перезагрузку: тогда список уже его.
  const already = await rowOf(TITLES.parent)
    .waitFor({ timeout: 3000 })
    .then(() => true)
    .catch(() => false);
  if (!already) {
    await page.getByRole('tab', { name: 'Проекты' }).click({ timeout: 15_000 });
    await page.waitForTimeout(600);
    await page
      .getByRole('button', { name: new RegExp(PROJECT.name) })
      .first()
      .click();
  }
  await rowOf(TITLES.parent).waitFor({ timeout: 20_000 });
  await page.waitForTimeout(600);
};

try {
  await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
  await page.evaluate((key) => localStorage.removeItem(key), STORAGE_KEY);
  await openProject();
  await shot('01-collapsed');

  // ── Свёрнуто по умолчанию ──────────────────────────────────────────────
  check(await visible(TITLES.running), 'идущая группа видна под родителем');
  check(!(await visible(TITLES.idle1)), 'группа «Отчёты» на стадии без прогона свёрнута');
  check(!(await visible(TITLES.idle2)), 'стоящая группа «Экспорт» свёрнута');
  check(!(await visible(TITLES.retired)), 'снятая группа свёрнута');
  const moreP = more(P);
  check((await moreP.count()) === 1, 'у ветви «Пачка задач» одна гармошка');
  check(
    (await moreP.innerText().catch(() => '')).includes('Ещё 3'),
    'гармошка «Пачка задач» считает свёрнутых: «Ещё 3»',
    await moreP.innerText().catch(() => 'нет'),
  );
  check(
    (await moreP.getAttribute('aria-expanded').catch(() => null)) === 'false',
    'гармошка свёрнута: aria-expanded=false',
  );
  const moreQ = more(Q);
  check(
    (await moreQ.innerText().catch(() => '')).includes('Ещё 2') &&
      !(await visible(TITLES.night1)) &&
      !(await visible(TITLES.night2)),
    'ветвь без идущих детей: гармошка держит всех («Ещё 2»)',
    await moreQ.innerText().catch(() => 'нет'),
  );
  check(
    (await topOf(rowOf(TITLES.running))) < (await topOf(moreP)),
    'гармошка стоит под идущими детьми ветви',
  );
  check(
    !(await page.getByText('Неактивно', { exact: true }).isVisible()),
    'свёрнуто: «Неактивно» не видно',
  );

  // ── Клавиатура: Enter раскрывает ──────────────────────────────────────
  await moreP.focus().catch(() => {});
  await page.keyboard.press('Enter');
  await page.waitForTimeout(400);
  check(
    (await moreP.getAttribute('aria-expanded').catch(() => null)) === 'true',
    'Enter на гармошке раскрыл ветвь: aria-expanded=true',
  );
  check(
    (await visible(TITLES.idle1)) && (await visible(TITLES.idle2)),
    'раскрыто: стоящие группы видны',
  );
  const divider = page.getByText('Неактивно', { exact: true }).first();
  const order = [
    await topOf(rowOf(TITLES.running)),
    await topOf(moreP),
    await topOf(rowOf(TITLES.idle1)),
    await topOf(rowOf(TITLES.idle2)),
    await topOf(divider),
    await topOf(rowOf(TITLES.retired)),
  ];
  check(
    order.every((value, index) => value >= 0 && (index === 0 || value > order[index - 1])),
    'порядок ветви: идущая › гармошка › стоящие › «Неактивно» › снятая',
    order.map((value) => Math.round(value)).join(' < '),
  );
  // Строки виртуального списка не наезжают: каждая следующая — ниже конца предыдущей.
  const boxes = [];
  for (const locator of [
    rowOf(TITLES.running),
    moreP,
    rowOf(TITLES.idle1),
    rowOf(TITLES.idle2),
    divider,
    rowOf(TITLES.retired),
  ]) {
    boxes.push(await boxOf(locator));
  }
  const overlaps = boxes
    .slice(1)
    .filter(
      (box, index) => !box || !boxes[index] || box.y < boxes[index].y + boxes[index].height - 0.5,
    );
  check(
    overlaps.length === 0,
    'строки ветви не наезжают друг на друга',
    JSON.stringify(boxes.map((box) => box && [Math.round(box.y), Math.round(box.height)])),
  );
  const moreBox = await boxOf(moreP);
  check(
    Boolean(moreBox) && moreBox.height >= 24 && moreBox.height <= 32,
    'строка-гармошка в своей высоте (≤ 32px)',
    moreBox ? String(Math.round(moreBox.height)) : 'нет',
  );
  await shot('02-expanded');

  // ── Память через перезагрузку ─────────────────────────────────────────
  await openProject();
  check(
    (await more(P)
      .getAttribute('aria-expanded')
      .catch(() => null)) === 'true' && (await visible(TITLES.idle1)),
    'после перезагрузки «Пачка задач» раскрыта (память на родителя)',
  );
  check(
    (await more(Q)
      .getAttribute('aria-expanded')
      .catch(() => null)) === 'false' && !(await visible(TITLES.night1)),
    'после перезагрузки «Ночная пачка» свёрнута — память своя у каждой ветви',
  );

  // ── Пробел сворачивает ────────────────────────────────────────────────
  await more(P)
    .focus()
    .catch(() => {});
  await page.keyboard.press('Space');
  await page.waitForTimeout(400);
  check(
    (await more(P)
      .getAttribute('aria-expanded')
      .catch(() => null)) === 'false' && !(await visible(TITLES.idle1)),
    'пробел свернул ветвь обратно',
  );

  // ── Поиск: найденное видно, гармошек нет ─────────────────────────────
  const search = page.getByRole('searchbox').or(page.getByLabel('Поиск по чатам')).first();
  await search.fill('Экспорт');
  await page.waitForTimeout(700);
  check(await visible(TITLES.idle2), 'поиск: свёрнутая группа «Экспорт» найдена и видна');
  check((await page.locator('[data-chat-more]').count()) === 0, 'поиск: гармошек нет');
  await shot('03-search');
  await search.fill('');
  await page.waitForTimeout(700);
  check(
    (await more(P).count()) === 1 && !(await visible(TITLES.idle2)),
    'поиск очищен: ветвь снова свёрнута, как была',
  );

  // ── Битое значение в хранилище ───────────────────────────────────────
  await page.evaluate((key) => localStorage.setItem(key, '{не json'), STORAGE_KEY);
  await openProject();
  check(
    (await more(P)
      .getAttribute('aria-expanded')
      .catch(() => null)) === 'false',
    'битое значение в хранилище: ветвь свёрнута, страница жива',
  );
  check(errors.length === 0, 'страница без ошибок', errors.join(' | '));
} finally {
  await browser.close();
}

const bad = rows.filter((row) => !row.ok).length;
console.log(`\nитог: проверок ${rows.length}, плохо ${bad}`);
process.exit(bad === 0 ? 0 : 1);
