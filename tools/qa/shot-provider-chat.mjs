/**
 * Снимок чата чужого провайдера для отчёта. Данные подменены так же, как в
 * `check-provider-chat.mjs`: настоящий CLI не запускается, настройки панели не
 * трогаются.
 *
 * Запуск: `node tools/qa/shot-provider-chat.mjs <путь к png>` при поднятом `pnpm dev`.
 */
import { chromium } from 'playwright';
import { bypassOnboarding } from './bypass-onboarding.mjs';

const BASE = process.env.APP_URL ?? 'http://localhost:8888';
const OUT = process.argv[2] ?? '.agent/screenshots/before-after/provider-chat/chat_AFTER.png';

const at = '2026-08-02T10:00:00.000Z';
const messages = [
  { id: 'u1', role: 'user', content: 'Посмотри, что это за проект', at },
  {
    id: 'a1',
    role: 'assistant',
    content:
      'Это монорепа на pnpm: apps/server — Fastify, apps/web — React + Vite,\nобщие типы в packages/contracts.',
    at,
    transport: 'stream',
  },
  { id: 'u2', role: 'user', content: 'А тесты чем гоняются?', at },
];

const chat = {
  id: 'qa1',
  providerId: 'codex',
  title: 'Посмотри, что это за проект',
  createdAt: at,
  updatedAt: at,
  messageCount: messages.length,
  // Каталог берём настоящий: на Linux и macOS зашитый путь вида C:\… выглядел бы
  // в снимке чужеродно, а бейдж рабочего каталога проверяется именно глазами.
  workdir: process.cwd(),
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
  json(route, [chat, { ...chat, id: 'qa2', title: 'Почини сборку', messageCount: 8 }]),
);
await page.route('**/api/provider-chat/chats/qa1', (route) => json(route, { ...chat, messages }));
await page.route('**/api/provider-chat/chats/qa1/status', (route) =>
  json(route, { chatId: 'qa1', isRunning: true, partial: 'vitest — по прогону на приложение' }),
);
await page.route('**/api/provider-chat/chats/qa1/stream', (route) =>
  route.fulfill({
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
    body: ': ping\n\n',
  }),
);

await page.goto(`${BASE}/chat`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('nav');
await page.waitForTimeout(2000);
await page.screenshot({ path: OUT, fullPage: false });
await browser.close();
console.log(`Снимок: ${OUT}`);
