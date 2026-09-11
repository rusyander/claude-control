/**
 * Снимок хаба родителя у чужого провайдера (Т2 партии «автономия у чужих CLI»).
 * Данные подменены так же, как в `check-provider-hub.mjs`: настоящий CLI не
 * запускается, настройки панели не трогаются.
 *
 * `EMPTY=1` снимает состояние ДО задачи: разделение связей не писало, дерево у
 * родителя пустое — и лента выглядит ровно так, как выглядела. `PAUSED=1` —
 * дерево на паузе (Т5): кнопка продолжения и отметка «на паузе».
 * `OVERLAP=idle|counted` — сверка веток (Т4): до нажатия и с посчитанным итогом.
 *
 * Запуск: `node tools/qa/shot-provider-hub.mjs <путь к png>` при поднятом `pnpm dev`.
 */
import { chromium } from 'playwright';
import { bypassOnboarding } from './bypass-onboarding.mjs';

const BASE = process.env.APP_URL ?? 'http://localhost:8888';
const OUT = process.argv[2] ?? '.agent/screenshots/before-after/f2-foreign-tree/hub_AFTER.png';
const EMPTY = process.env.EMPTY === '1';
const PAUSED = process.env.PAUSED === '1';
const OVERLAP = process.env.OVERLAP;

const at = '2026-09-09T10:00:00.000Z';
const messages = [
  { id: 'u1', role: 'user', content: 'Раздели работу по чтению и записи на две группы', at },
  {
    id: 'a1',
    role: 'assistant',
    content:
      'Разделил: чтение (src/read.ts, парсер) и запись (src/write.ts, буфер).\nКаждая группа идёт в своей копии, ветки не пересекаются.',
    at,
    transport: 'stream',
    durationMs: 41_000,
  },
];

const chat = {
  id: 'qa1',
  providerId: 'codex',
  title: 'Раздели работу по чтению и записи',
  createdAt: at,
  updatedAt: at,
  messageCount: messages.length,
  workdir: process.cwd(),
};

const TREE = {
  root: 'codex:qa1',
  running: 1,
  nodes: [
    {
      chatId: 'codex:kid1',
      aliases: [],
      parentChatId: 'codex:qa1',
      title: 'Чтение · план',
      branch: 'split/read',
      stage: 'plan',
      running: false,
    },
    {
      chatId: 'codex:kid1',
      aliases: [],
      parentChatId: 'codex:qa1',
      title: 'Чтение · работа',
      branch: 'split/read',
      stage: 'work',
      running: true,
    },
    {
      chatId: 'codex:kid2',
      aliases: [],
      parentChatId: 'codex:qa1',
      title: 'Запись · ревью',
      branch: 'split/write',
      stage: 'review',
      running: false,
    },
  ],
};

/** Запись конвейера уровней: из неё сверка берёт названия групп (Т4). */
const SPLIT = {
  parentChatId: 'codex:qa1',
  order: [0, 1],
  groups: [
    { index: 0, title: 'Чтение', branch: 'split/read', after: [], status: 'started' },
    { index: 1, title: 'Запись', branch: 'split/write', after: [], status: 'done' },
  ],
  ...(OVERLAP === 'counted'
    ? {
        overlap: {
          at: '2026-09-09T12:30:00.000Z',
          files: [
            { path: 'src/shared/columns.ts', groups: [0, 1], outside: [1] },
            { path: 'src/report.ts', groups: [0, 1], outside: [] },
          ],
          mergeOrder: [0, 1],
          counted: [
            { index: 0, files: 6 },
            { index: 1, files: 4 },
          ],
          unread: [],
        },
      }
    : {}),
};

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
await bypassOnboarding(page);

const json = (route, body) =>
  route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });

await page.route('**/api/settings', async (route) => {
  if (route.request().method() !== 'GET') return route.continue();
  const response = await route.fetch();
  await route.fulfill({ response, json: { ...(await response.json()), provider: 'codex' } });
});
await page.route('**/api/provider-runner', (route) =>
  json(route, { providerId: 'codex', providerName: 'Codex', mode: 'cli' }),
);
await page.route('**/api/provider-chat/chats', (route) =>
  json(route, [
    chat,
    { ...chat, id: 'kid1', title: 'Чтение · работа', messageCount: 6 },
    { ...chat, id: 'kid2', title: 'Запись · ревью', messageCount: 4 },
  ]),
);
await page.route('**/api/provider-chat/chats/qa1', (route) => json(route, { ...chat, messages }));
await page.route('**/api/provider-chat/chats/qa1/status', (route) =>
  json(route, { chatId: 'qa1', isRunning: false, partial: '' }),
);
await page.route('**/api/chat/*/tree', (route) => {
  if (EMPTY) return json(route, { root: 'codex:qa1', running: 0, nodes: [] });
  if (PAUSED) {
    return json(route, {
      ...TREE,
      running: 0,
      nodes: TREE.nodes.map((node) => ({ ...node, running: false })),
      paused: { at: '2026-09-09T12:00:00.000Z', chats: 1, pending: 1 },
    });
  }
  return json(route, OVERLAP ? { ...TREE, split: SPLIT } : TREE);
});

await page.goto(`${BASE}/chat`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('nav');
await page.waitForTimeout(2000);
await page.screenshot({ path: OUT, fullPage: false });
await browser.close();
console.log(`Снимок: ${OUT}`);
