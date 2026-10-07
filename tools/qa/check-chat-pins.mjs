/**
 * Закрепление разговоров в боковой панели и ветвь удалённого родителя
 * (владелец, 07.10.2026).
 *
 * - Булавка есть у корней и отдельных разговоров, у чата группы её нет: ребёнок
 *   едет вверх за родителем.
 * - Нажатие отправляет `PUT /api/chats/:id/pin` с `pinned: true`; ветвь целиком
 *   (родитель, его гармошка) встаёт под заголовок «Закреплённые» выше
 *   «Сейчас работают» и дат. Метка приходит от сервера, поэтому переживает
 *   перезагрузку; повторное нажатие — `pinned: false`, ветвь возвращается к дате.
 * - Отказ сервера (409) возвращает строку на место — список не врёт.
 * - Дети, чей родитель удалён с диска (Claude Code стёр транскрипт по
 *   `cleanupPeriodDays`), собраны под заглушкой «Родительский чат удалён» с
 *   гармошкой, а не рассыпаны по датам; заглушка не кнопка и без булавки.
 * - Клавиатура: булавка достижима Tab и жмётся Enter.
 *
 * Данные подменены целиком; заглушка `PUT …/pin` ведёт себя как сервер (хранит
 * закрепления и отдаёт `pinnedAt` в следующем `GET /api/chats`) — серверная
 * половина доказана `transcript-routes.pin.integration.test.ts` на настоящем
 * маршруте и хранилище. Любая другая запись к серверу — 501.
 *
 * Запуск: `node tools/qa/check-chat-pins.mjs` при поднятом фронте
 * (`APP_URL`, по умолчанию http://localhost:8888); `SHOTS=<папка>` — снимки.
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { bypassOnboarding } from './bypass-onboarding.mjs';

const BASE = process.env.APP_URL ?? 'http://localhost:8888';
const SHOTS = process.env.SHOTS;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const PROJECT = { name: 'QA закрепления', path: 'C:/qa-pins-project' };
const NOW = Date.now();

const chat = (id, title, extra = {}) => ({
  id,
  title,
  project: PROJECT.name,
  projectPath: PROJECT.path,
  isSandbox: false,
  messageCount: 3,
  createdAt: new Date(NOW - 3_600_000).toISOString(),
  updatedAt: new Date(NOW - (extra.ago ?? 60) * 60_000).toISOString(),
  preview: '',
  ...(extra.parentId ? { parentId: extra.parentId } : {}),
  ...(extra.branch ? { branch: extra.branch } : {}),
});

const P = 'qa-pin-parent';
const GONE = 'qa-pin-gone-parent';
const TITLES = {
  fresh: 'Свежий отдельный разговор',
  parent: 'Пачка фронтовых багов',
  child1: 'Группа «Таблицы»',
  child2: 'Группа «Формы»',
  orphan1: 'Сирота «Документация»',
  orphan2: 'Сирота «Политики»',
  loose: 'Старый отдельный разговор',
};
const CHATS = [
  chat('qa-pin-fresh', TITLES.fresh, { ago: 2 }),
  chat('qa-pin-o1', TITLES.orphan1, { parentId: GONE, branch: 'fix/docs', ago: 10 }),
  chat('qa-pin-o2', TITLES.orphan2, { parentId: GONE, branch: 'fix/policies', ago: 12 }),
  chat(P, TITLES.parent, { ago: 30 }),
  chat('qa-pin-c1', TITLES.child1, { parentId: P, branch: 'fix/tables', ago: 31 }),
  chat('qa-pin-c2', TITLES.child2, { parentId: P, branch: 'fix/forms', ago: 32 }),
  chat('qa-pin-loose', TITLES.loose, { ago: 50 }),
];

// Сервер-заглушка закреплений: что приняли, то и отдаём в списке.
const pins = new Map();
const puts = [];
let refuseNext = false;
const listed = () =>
  CHATS.map((item) => (pins.has(item.id) ? { ...item, pinnedAt: pins.get(item.id) } : item));

const rows = [];
const check = (ok, text, detail = '') => {
  rows.push({ ok, text });
  console.log(`${ok ? 'ок    ' : 'ПЛОХО ×'} ${text}${detail ? ` — ${detail}` : ''}`);
  return ok;
};

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.setDefaultTimeout(4000);
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
await bypassOnboarding(page);
await page.route('**/api/**', (route) =>
  route.request().method() === 'GET'
    ? route.fallback()
    : route.fulfill({ status: 501, json: { error: 'qa: запись закрыта' } }),
);
await page.route('**/api/chats', (route) => route.fulfill({ json: listed() }));
await page.route('**/api/chats/*/pin', async (route) => {
  const request = route.request();
  if (request.method() !== 'PUT') return route.fallback();
  const id = decodeURIComponent(new URL(request.url()).pathname.split('/').at(-2) ?? '');
  const body = request.postDataJSON();
  puts.push({ id, pinned: body?.pinned });
  if (refuseNext) {
    refuseNext = false;
    return route.fulfill({ status: 409, json: { message: 'qa: отказ', code: 'qa_refused' } });
  }
  if (body?.pinned) pins.set(id, new Date().toISOString());
  else pins.delete(id);
  return route.fulfill({ json: { id, pinned: body?.pinned } });
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
await page.route('**/api/chat/active', (route) => route.fulfill({ json: [] }));

const shot = async (name) => {
  if (SHOTS) await page.screenshot({ path: join(SHOTS, `${name}.png`) });
};
function escape(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
const rowOf = (title) => page.getByRole('button', { name: new RegExp(escape(title)) }).first();
const pinOf = (id) => page.locator(`[data-chat-pin="${id}"]`);
const topOf = async (locator) =>
  (await locator.count()) > 0 && (await locator.isVisible())
    ? ((await locator.boundingBox())?.y ?? -1)
    : -1;
const headerTop = (text) => topOf(page.getByText(text, { exact: true }).first());
const settle = async (predicate, what) => {
  for (let i = 0; i < 40; i += 1) {
    if (await predicate()) return true;
    await page.waitForTimeout(150);
  }
  console.log(`  (не дождался: ${what})`);
  return false;
};

const openProject = async () => {
  await page.goto(`${BASE}/chat`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('nav');
  await page.waitForTimeout(1200);
  const already = await rowOf(TITLES.parent)
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
  await rowOf(TITLES.parent).waitFor({ timeout: 20_000 });
  await page.waitForTimeout(600);
};

try {
  await openProject();
  await shot('01-before-pin');

  // ── Булавки и заглушка до закрепления ─────────────────────────────────
  check((await pinOf(P).count()) === 1, 'у родителя разделения есть булавка');
  check((await pinOf('qa-pin-loose').count()) === 1, 'у отдельного разговора есть булавка');
  await page.locator(`[data-chat-more="${P}"]`).click();
  await settle(() => rowOf(TITLES.child1).isVisible(), 'дети раскрыты');
  check(
    (await pinOf('qa-pin-c1').count()) === 0 && (await rowOf(TITLES.child1).isVisible()),
    'у чата группы булавки нет (он виден, кнопки нет)',
  );
  check(
    (await page.getByText('Закреплённые', { exact: true }).count()) === 0,
    'без закреплений заголовка «Закреплённые» нет',
  );
  const stub = page.locator(`[data-chat-lost-parent="${GONE}"]`);
  check(
    (await stub.count()) === 1 && (await stub.innerText()).includes('Родительский чат удалён'),
    'сироты удалённого родителя собраны под заглушкой «Родительский чат удалён»',
  );
  check(
    (
      await page
        .locator(`[data-chat-more="${GONE}"]`)
        .innerText()
        .catch(() => '')
    ).includes('Ещё 2'),
    'под заглушкой гармошка «Ещё 2»',
  );
  check(
    !(await rowOf(TITLES.orphan1).isVisible()),
    'сирота свёрнута под гармошкой, а не строкой по дате',
  );
  check(
    (await stub.evaluate((node) => node.tagName)) !== 'BUTTON' && (await pinOf(GONE).count()) === 0,
    'заглушка не кнопка и без булавки',
  );

  // ── Закрепить родителя ─────────────────────────────────────────────────
  await rowOf(TITLES.parent).hover();
  await pinOf(P).click();
  await settle(async () => (await headerTop('Закреплённые')) >= 0, 'заголовок «Закреплённые»');
  check(
    puts.at(-1)?.id === P && puts.at(-1)?.pinned === true,
    'ушёл PUT pin с pinned: true',
    JSON.stringify(puts.at(-1)),
  );
  const pinnedHeader = await headerTop('Закреплённые');
  const parentTop = await topOf(rowOf(TITLES.parent));
  const freshTop = await topOf(rowOf(TITLES.fresh));
  check(
    pinnedHeader >= 0 && pinnedHeader < parentTop && parentTop < freshTop,
    'ветвь под «Закреплёнными» выше свежего разговора',
    `заголовок ${pinnedHeader}, родитель ${parentTop}, свежий ${freshTop}`,
  );
  const childTop = await topOf(rowOf(TITLES.child1));
  check(
    childTop > parentTop && childTop < freshTop,
    'ребёнок уехал наверх вместе с родителем',
    `ребёнок ${childTop}`,
  );
  check((await pinOf(P).getAttribute('aria-pressed')) === 'true', 'булавка нажата (aria-pressed)');
  await shot('02-pinned');

  // ── Переживает перезагрузку: метка от сервера ──────────────────────────
  await openProject();
  await settle(async () => (await headerTop('Закреплённые')) >= 0, 'заголовок после перезагрузки');
  check(
    (await headerTop('Закреплённые')) >= 0 &&
      (await topOf(rowOf(TITLES.parent))) < (await topOf(rowOf(TITLES.fresh))),
    'после перезагрузки ветвь всё ещё закреплена',
  );

  // ── Отказ сервера — строка возвращается ───────────────────────────────
  refuseNext = true;
  await rowOf(TITLES.loose).hover();
  await pinOf('qa-pin-loose').click();
  await page.waitForTimeout(1500);
  check(
    (await topOf(rowOf(TITLES.loose))) > (await topOf(rowOf(TITLES.fresh))),
    'отказ 409: отдельный разговор остался внизу, не закрепился',
  );

  // ── Клавиатура: открепить Enter-ом ─────────────────────────────────────
  await pinOf(P).focus();
  await page.keyboard.press('Enter');
  await settle(
    async () => (await page.getByText('Закреплённые', { exact: true }).count()) === 0,
    'заголовок ушёл',
  );
  check(
    puts.at(-1)?.id === P && puts.at(-1)?.pinned === false,
    'Enter на булавке — PUT pin с pinned: false',
  );
  check(
    (await page.getByText('Закреплённые', { exact: true }).count()) === 0 &&
      (await topOf(rowOf(TITLES.parent))) > (await topOf(rowOf(TITLES.fresh))),
    'откреплённая ветвь вернулась к своей дате',
  );
  await shot('03-unpinned');

  check(errors.length === 0, 'страница без ошибок', errors.join(' | '));
} finally {
  await browser.close();
}
const bad = rows.filter((row) => !row.ok).length;
console.log(
  bad === 0
    ? `\nВсё сходится: ${rows.length}/${rows.length}.`
    : `\nПЛОХО: ${bad} из ${rows.length}.`,
);
process.exit(bad === 0 ? 0 : 1);
