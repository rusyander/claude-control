/**
 * Потоков прогонов на вкладку — не больше `MAX_STREAMS`, и отправка при
 * полном бюджете всё равно уходит.
 *
 * Беда, ради которой прогон появился (аудит чата, Т2): браузер по HTTP/1.1 даёт
 * шесть соединений на источник, на все вкладки разом. Поток на каждый идущий
 * прогон плюс лента событий съедали пул целиком, и `POST /api/chat/send` в
 * седьмой разговор вставал в очередь браузера — без ошибки и без срока, ровно
 * так, как выглядит «панель зависла». Теперь стор держит три потока, остальные
 * прогоны припаркованы (ведутся опросом `/api/chat/active`), а отправка
 * отпускает младший поток, если места нет.
 *
 * Данные подменяются целиком: шесть «идущих» прогонов приходят из подменённого
 * `/api/chat/active`, потоки к ним прогон держит открытыми (маршрут не отвечает
 * вовсе — так поток «висит», как настоящий), и никакой агент не запускается.
 *
 * Запуск: `node tools/qa/check-stream-cap.mjs` при поднятом `pnpm dev`.
 */
import { chromium } from 'playwright';
import { bypassOnboarding } from './bypass-onboarding.mjs';

const MAX_STREAMS = 3;
const PROJECT = { name: 'QA лимит потоков', path: 'C:/qa-stream-cap' };
const RUNNING = ['cap-1', 'cap-2', 'cap-3', 'cap-4', 'cap-5', 'cap-6'];
const SEVENTH = 'cap-7';

const chat = (id, title) => ({
  id,
  title,
  project: PROJECT.name,
  projectPath: PROJECT.path,
  isSandbox: false,
  messageCount: 1,
  createdAt: '2026-09-05T10:00:00.000Z',
  updatedAt: '2026-09-05T10:05:00.000Z',
  preview: title,
});
const CHATS = [...RUNNING.map((id, i) => chat(id, `Идущий ${i + 1}`)), chat(SEVENTH, 'Седьмой')];

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
await bypassOnboarding(page);

const errors = [];
page.on('console', (message) => {
  if (message.type() === 'error') errors.push(message.text().slice(0, 200));
});

await page.route('**/api/project-git*', (route) =>
  route.fulfill({
    json: { isRepo: false, detached: false, unborn: false, branches: [], changes: [] },
  }),
);
await page.route('**/api/chats/projects*', (route) =>
  route.fulfill({
    json: [
      {
        path: PROJECT.path,
        name: PROJECT.name,
        exists: true,
        lastActivity: '2026-09-05T10:00:00.000Z',
        chats: CHATS,
      },
    ],
  }),
);
await page.route('**/api/chats', (route) => route.fulfill({ json: CHATS }));
await page.route('**/api/chats/*/messages*', (route) =>
  route.fulfill({ json: { messages: [], total: 0, hasMore: false } }),
);
await page.route('**/api/chat/*/progress*', (route) =>
  route.fulfill({ json: { steps: [], isComplete: false } }),
);
await page.route('**/api/chat/*/artifacts*', (route) => route.fulfill({ json: [] }));

// Шесть идущих прогонов — все старше друг друга на секунду, чтобы порядок
// парковки был предсказуем: младшие ждут, старшие держат поток.
await page.route('**/api/chat/active', (route) =>
  route.fulfill({
    json: RUNNING.map((chatId, i) => ({
      chatId,
      sessionId: chatId,
      projectPath: PROJECT.path,
      seq: 0,
      startedAt: 1_757_000_000_000 + i * 1000,
      status: 'running',
    })),
  }),
);

// Потоки и отправку не отвечаем вовсе: запрос висит, как висел бы настоящий
// поток, — а нам важно только, сколько их открыто и какие оборваны.
const opened = [];
const aborted = [];
await page.route('**/api/chat/*/stream*', (route) => {
  opened.push(route.request().url());
});
let sendFired = 0;
await page.route('**/api/chat/send', () => {
  sendFired += 1;
});
page.on('requestfailed', (request) => {
  if (request.url().includes('/api/chat/') && request.url().includes('/stream')) {
    aborted.push(request.url());
  }
});

await page.goto(process.env.APP_URL ?? 'http://localhost:8888/chat');
await page.waitForSelector('nav');
await page.waitForTimeout(1200);

let bad = 0;
const check = (ok, text) => {
  console.log(`${ok ? 'ок  ' : 'ПЛОХО'} ${text}`);
  if (!ok) bad += 1;
};

await page.getByRole('tab', { name: 'Проекты' }).click();
await page.waitForTimeout(800);
await page
  .getByRole('button', { name: new RegExp(PROJECT.name) })
  .first()
  .click();
await page.waitForTimeout(1500);

// Открываем седьмой — не идущий: у шести приоритет одинаковый, поток держат
// трое старших.
await page
  .getByRole('button', { name: /Седьмой/ })
  .first()
  .click();
await page.waitForTimeout(2500);

const live = () => opened.filter((url) => !aborted.includes(url));
check(
  live().length === MAX_STREAMS,
  `шесть прогонов на сервере — открытых потоков ${live().length} (предел ${MAX_STREAMS})`,
);
check(
  ['cap-1', 'cap-2', 'cap-3'].every((id) =>
    opened.some((url) => url.includes(`/chat/${id}/stream`)),
  ),
  'поток достался трём старшим прогонам',
);

// В пульте видны все шесть — припаркованные тоже «работают», просто без потока.
const dockRows = await page.getByText(/Идущий \d/).count();
check(dockRows >= RUNNING.length, `все шесть прогонов на экране (найдено строк: ${dockRows})`);

// Отправка в седьмой: при полном бюджете уходит сразу, вытесняя младший поток.
const composer = page.getByRole('textbox', { name: /Спросите что угодно/ });
await composer.fill('седьмое сообщение');
await composer.press('Enter');
await page.waitForTimeout(1500);

check(sendFired === 1, `запрос /api/chat/send ушёл сразу (ушло: ${sendFired})`);
check(aborted.length >= 1, `ради отправки отпущен один поток (оборвано: ${aborted.length})`);
check(
  aborted.some((url) => url.includes('/chat/cap-3/stream')),
  'отпущен именно младший из державших (cap-3)',
);
check(
  live().length + sendFired <= MAX_STREAMS,
  `потоков вместе с отправкой не больше предела (${live().length} + ${sendFired})`,
);

// Открытый разговор важнее фонового: переход в припаркованный даёт ему поток.
await page
  .getByRole('button', { name: /Идущий 6/ })
  .first()
  .click();
await page.waitForTimeout(2000);
check(
  opened.some((url) => url.includes('/chat/cap-6/stream')),
  'открытый припаркованный разговор получил поток',
);
check(live().length <= MAX_STREAMS, `предел держится и после переключения (${live().length})`);

check(errors.length === 0, errors.length === 0 ? 'ошибок консоли нет' : errors.join(' | '));

await browser.close();
console.log(bad === 0 ? 'Лимит потоков держится, отправка уходит' : `Проблем: ${bad}`);
process.exit(bad === 0 ? 0 : 1);
