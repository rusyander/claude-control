/**
 * Карточка «Первая правка — где работаем?» и ветка правки своей реплики
 * (замечания из Telegram 26.10, R1 и R2).
 *
 * R1 — карточка ворот ветки у родителя, чья работа отдана группам:
 * - имя ветки в поле — из слов человека, а не из сводки детей панели
 *   (`agent/agentdeck-children-the-work-of-…`). Имя считает НАСТОЯЩАЯ
 *   `suggestBranchName` сервера над тем же промптом, что ставит реестр
 *   (`withChildrenBrief` + `childrenBrief`), — дочерним процессом node;
 * - на карточке назван файл, который агент собирался править (`input.file_path`);
 * - у карточки есть «?» в справку чата.
 *
 * R2 — правка своей реплики (карандаш «Изменить и отправить в новой ветке»):
 * - ветка в списке подписана «ветка от «<название>»», исходный разговор — нет;
 * - отправка ветки спрашивает подтверждение; «Отмена» ничего не шлёт и текст
 *   оставляет; подтверждение шлёт `fork: true` с сессией исходного разговора;
 * - очищенное поле снимает пометку ветки: следующее сообщение уходит в тот же
 *   разговор без вопроса и без `fork`.
 *
 * Данные подменены целиком (список, лента, прогон, поток событий); любая запись,
 * кроме `POST /api/chat/send`, — 501. Серверная половина доказана тестами
 * маршрутов (`run-routes.branch-gate.integration.test.ts`,
 * `transcript-routes.fork.integration.test.ts`).
 *
 * Запуск: `node tools/qa/check-branch-gate-fork.mjs` при поднятом фронте
 * (`APP_URL`, по умолчанию http://localhost:8888); `SHOTS=<папка>` — снимки,
 * `PHASE=before|after` — суффикс имён снимков.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { bypassOnboarding } from './bypass-onboarding.mjs';

const BASE = process.env.APP_URL ?? 'http://localhost:8888';
const SHOTS = process.env.SHOTS;
const PHASE = process.env.PHASE ? `-${process.env.PHASE}` : '';
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const ROOT = fileURLToPath(new URL('../..', import.meta.url));

const PROJECT = { name: 'QA ворота и ветки', path: 'C:/qa-branch-gate' };
const PARENT = 'qa-bg-parent-cdd372';
const ORIGIN = 'qa-fork-origin';
const FORK = 'qa-fork-branch';
const ASKED = 'Поправь шапку на главной';
const ORIGIN_TITLE = 'Перенос среды между CLI';
const TARGET = 'C:/qa-branch-gate/src/Header.tsx';
const NOW = Date.now();

const serverModule = (path) =>
  pathToFileURL(join(ROOT, 'apps', 'server', 'src', 'domains', 'chat', path)).href;

/** Имя ветки — настоящей функцией сервера над промптом, который ставит реестр. */
function serverBranchName() {
  const code = `
    const gate = await import(${JSON.stringify(serverModule('ChatBranchGate/ChatBranchGate.ts'))});
    const brief = await import(${JSON.stringify(serverModule('children-brief/children-brief.ts'))});
    const plan = { parentChatId: ${JSON.stringify(PARENT)}, order: [0], groups: [
      { index: 0, title: 'Шапка', branch: 'fix/header', after: [], status: 'started' } ] };
    const prompt = brief.withChildrenBrief(${JSON.stringify(ASKED)}, brief.childrenBrief(plan));
    process.stdout.write(gate.suggestBranchName(prompt, ${JSON.stringify(PARENT)}));
  `;
  return execFileSync(
    process.execPath,
    ['--experimental-strip-types', '--no-warnings', '--input-type=module', '-e', code],
    { encoding: 'utf8', cwd: ROOT },
  ).trim();
}
const BRANCH = serverBranchName();

const chat = (id, title, extra = {}) => ({
  id,
  title,
  project: PROJECT.name,
  projectPath: PROJECT.path,
  isSandbox: false,
  messageCount: 4,
  createdAt: new Date(NOW - 3_600_000).toISOString(),
  updatedAt: new Date(NOW - (extra.ago ?? 5) * 60_000).toISOString(),
  preview: '',
  ...(extra.forkOf ? { forkOf: extra.forkOf } : {}),
});
const CHATS = [
  chat(PARENT, ASKED, { ago: 1 }),
  chat(FORK, ORIGIN_TITLE, { ago: 2, forkOf: { id: ORIGIN, title: ORIGIN_TITLE } }),
  chat(ORIGIN, ORIGIN_TITLE, { ago: 3 }),
];

const MESSAGES = {
  messages: [
    {
      id: 'u-1',
      role: 'user',
      blocks: [{ type: 'text', text: 'Перенеси настройки на второй компьютер' }],
      timestamp: new Date(NOW - 600_000).toISOString(),
    },
    {
      id: 'a-1',
      role: 'assistant',
      blocks: [{ type: 'text', text: 'Перенёс: правила, хуки и разрешения.' }],
      timestamp: new Date(NOW - 590_000).toISOString(),
    },
  ],
  total: 2,
  hasMore: false,
};

const GATE = {
  kind: 'branchGate',
  seq: 1,
  toolName: 'Edit',
  input: { file_path: TARGET, old_string: 'Шапка', new_string: 'Новая шапка' },
  toolUseId: 'qa-gate-1',
  cwd: PROJECT.path,
  branch: BRANCH,
  children: [{ number: 1, title: 'Шапка', branch: 'fix/header', status: 'started' }],
  base: 'origin/fix/header',
};

const rows = [];
const check = (ok, text, detail = '') => {
  rows.push({ ok, text });
  console.log(`${ok ? 'ок    ' : 'ПЛОХО ×'} ${text}${detail ? ` — ${detail}` : ''}`);
  return ok;
};

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.setDefaultTimeout(5000);
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
await bypassOnboarding(page);

const sends = [];
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
await page.route('**/api/chats/*/messages*', (route) => route.fulfill({ json: MESSAGES }));
await page.route('**/api/chat/*/progress*', (route) =>
  route.fulfill({ json: { steps: [], isComplete: false } }),
);
await page.route('**/api/chat/*/artifacts*', (route) => route.fulfill({ json: [] }));
await page.route('**/api/chat/active', (route) =>
  route.fulfill({
    json: [
      {
        chatId: PARENT,
        sessionId: PARENT,
        projectPath: PROJECT.path,
        seq: 1,
        startedAt: NOW,
        status: 'running',
        model: 'claude-opus-5',
        effort: 'high',
      },
    ],
  }),
);
await page.route('**/api/chat/*/stream*', (route) => {
  const id = decodeURIComponent(new URL(route.request().url()).pathname.split('/').at(-2) ?? '');
  const frames = id === PARENT ? [GATE] : [];
  return route
    .fulfill({
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
      body: frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join(''),
    })
    .catch(() => undefined);
});
await page.route('**/api/chat/send', (route) => {
  if (route.request().method() !== 'POST') return route.fallback();
  sends.push(route.request().postDataJSON());
  return route.fulfill({
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
    body: `data: ${JSON.stringify({ kind: 'done', seq: 1 })}\n\n`,
  });
});

const shot = async (name, locator) => {
  if (!SHOTS) return;
  const path = join(SHOTS, `${name}${PHASE}.png`);
  if (locator && (await locator.count()) > 0) await locator.first().screenshot({ path });
  else await page.screenshot({ path });
};
const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const rowOf = (id) => page.locator(`[data-chat-row="${id}"]`);
const rowByTitle = (title) => page.getByRole('button', { name: new RegExp(escape(title)) }).first();
const settle = async (predicate) => {
  for (let i = 0; i < 40; i += 1) {
    if (await predicate().catch(() => false)) return true;
    await page.waitForTimeout(150);
  }
  return false;
};

const openProject = async () => {
  await page.goto(`${BASE}/chat`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('nav');
  await page.waitForTimeout(1200);
  const already = await rowByTitle(ASKED)
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
  await rowByTitle(ASKED).waitFor({ timeout: 20_000 });
  await page.waitForTimeout(600);
};

try {
  await openProject();

  // ── R1: карточка ворот ветки ─────────────────────────────────────────────
  await rowByTitle(ASKED).click();
  const title = page.getByText('Первая правка — где работаем?', { exact: true });
  await title.waitFor({ timeout: 15_000 }).catch(() => undefined);
  const card = page
    .locator('[data-branch-gate]')
    .or(title.locator('xpath=ancestor::div[2]'))
    .first();
  check((await card.count()) === 1, 'карточка ворот ветки показана');
  await page.waitForTimeout(400);
  await shot('01-branch-gate-card', card);

  const field = card.locator('input').first();
  const name = (await field.count()) ? await field.inputValue() : '';
  check(
    name === BRANCH && !name.includes('agentdeck'),
    'имя ветки — из слов человека, не из сводки детей',
    name,
  );
  check(name.startsWith('agent/poprav-shapku'), 'имя ветки начинается словами задания', name);
  const cardText = (await card.count()) ? await card.innerText() : '';
  check(cardText.includes(TARGET), 'на карточке назван файл правки', TARGET);
  const help = card.locator('a[href*="/help"]');
  const href = (await help.count()) ? await help.first().getAttribute('href') : '';
  check(Boolean(href?.includes('topic=chat')), '«?» карточки ведёт в справку чата', href ?? 'нет');

  // ── R2: ветка в списке ───────────────────────────────────────────────────
  const forkLabel = `ветка от «${ORIGIN_TITLE}»`;
  const sidebar = page.locator('[data-chat-list]').or(page.locator('aside')).first();
  const forkRow = rowOf(FORK)
    .or(page.locator('button', { hasText: forkLabel }))
    .first();
  await shot('02-chat-list', sidebar);
  check((await forkRow.count()) === 1, 'строка ветки подписана «ветка от «…»»');
  const originRows = page.getByRole('button', { name: new RegExp(escape(ORIGIN_TITLE)) });
  const originLabelled = await originRows.evaluateAll(
    (nodes, label) => nodes.filter((node) => node.textContent?.includes(label)).length,
    forkLabel,
  );
  check(
    (await originRows.count()) === 2 && originLabelled === 1,
    'у исходного разговора подписи ветки нет — подписана только ветка',
    `строк с названием: ${await originRows.count()}, подписанных: ${originLabelled}`,
  );

  // ── R2: подтверждение ветки ──────────────────────────────────────────────
  const originRow = originRows.filter({ hasNotText: forkLabel }).first();
  await originRow.click();
  const pencil = page.getByRole('button', { name: 'Изменить и отправить в новой ветке' }).first();
  await pencil.waitFor({ timeout: 15_000 });
  await pencil.click();
  const composer = page.getByPlaceholder(/Спросите что угодно/).first();
  await composer.fill('Перенеси настройки на второй и третий компьютер');
  await composer.press('Enter');
  const dialog = page.getByRole('dialog');
  const asked = await settle(async () => (await dialog.count()) > 0 && dialog.first().isVisible());
  check(asked, 'отправка ветки спрашивает подтверждение');
  check(sends.length === 0, 'до подтверждения ничего не отправлено', `отправок: ${sends.length}`);
  await shot('03-fork-confirm', dialog);
  if (asked) {
    await dialog.getByRole('button', { name: 'Отмена' }).click();
    await page.waitForTimeout(400);
    check(
      sends.length === 0 && (await composer.inputValue()).includes('третий компьютер'),
      '«Отмена» ничего не шлёт и оставляет текст в поле',
    );
    await composer.press('Enter');
    await settle(async () => (await dialog.count()) > 0 && dialog.first().isVisible());
    await dialog.getByRole('button', { name: /веткой/ }).click();
    await settle(async () => sends.length > 0);
  }
  const forked = sends.at(-1);
  check(
    forked?.fork === true && forked?.sessionId === ORIGIN,
    'подтверждённая ветка уходит с fork и сессией исходного',
    JSON.stringify({ fork: forked?.fork, sessionId: forked?.sessionId }),
  );

  // ── R2: очищенное поле снимает пометку ветки ─────────────────────────────
  const before = sends.length;
  await pencil.click();
  await composer.fill('');
  await composer.fill('Обычный вопрос в этот же разговор');
  await composer.press('Enter');
  await settle(async () => sends.length > before);
  const plain = sends.at(-1);
  check(
    sends.length === before + 1 && !plain?.fork && !(await dialog.isVisible().catch(() => false)),
    'после очистки поля — обычная отправка без вопроса и без fork',
    JSON.stringify({ sent: sends.length - before, fork: plain?.fork }),
  );
} catch (error) {
  check(false, 'сценарий дошёл до конца', String(error).slice(0, 300));
} finally {
  check(errors.length === 0, 'ошибок страницы нет', errors.join(' | ').slice(0, 300));
  await browser.close();
}

const bad = rows.filter((row) => !row.ok).length;
console.log(`\n${rows.length - bad}/${rows.length} ок`);
process.exit(bad === 0 ? 0 : 1);
