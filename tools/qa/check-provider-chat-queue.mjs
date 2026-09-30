/**
 * Очередь чата чужого провайдера: сообщение, написанное посреди ответа, не
 * отказ и не заблокированная кнопка, а очередь сервера — пузырь «уйдёт
 * следующим» в ленте, отмена до отправки, и по концу ответа сообщение уходит
 * само, а его ответ появляется без перезагрузки.
 *
 * Настоящий CLI не запускается и настройки панели не трогаются: активный
 * провайдер и весь `/api/provider-chat/*` подменяются на лету, а заглушка ведёт
 * себя как сервер (`ProviderChatService`): 202 с элементом очереди, очередь в
 * статусе, досылка по концу ответа.
 *
 * Запуск: `node tools/qa/check-provider-chat-queue.mjs` при поднятом `pnpm dev`.
 */
import { chromium } from 'playwright';
import { bypassOnboarding } from './bypass-onboarding.mjs';

const BASE = process.env.APP_URL ?? 'http://localhost:8888';

const CHAT = {
  id: 'qq1',
  providerId: 'codex',
  title: 'Очередь',
  createdAt: '2026-09-30T10:00:00.000Z',
  updatedAt: '2026-09-30T10:00:00.000Z',
  messageCount: 0,
};

const messages = [];
/** Очередь «сервера»: то, что вернёт статус и что уйдёт по концу ответа. */
let queue = [];
let isRunning = false;
let partial = '';
let answered = 0;
const sent = [];
const cancelled = [];

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
// Активный провайдер — чужой: подмена ответа, а не настроек на диске, и тем же
// перехватом, что обход мастера (второй маршрут настроек отменил бы его).
await bypassOnboarding(page, { provider: 'codex' });

const json = (route, body, status = 200) =>
  route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

await page.route('**/api/provider-runner', (route) =>
  json(route, { providerId: 'codex', providerName: 'Codex', mode: 'cli' }),
);
await page.route('**/api/platform-run-plan/**', (route) =>
  json(route, {
    routed: false,
    title: '',
    reason: 'consumer_off',
    rules: { model: '', source: 'none', map: {}, catalog: [] },
    effort: true,
  }),
);
await page.route('**/api/provider-chat/chats', (route) =>
  json(route, [{ ...CHAT, messageCount: messages.length }]),
);
await page.route('**/api/provider-chat/chats/qq1/status', (route) =>
  json(route, {
    chatId: 'qq1',
    isRunning,
    partial,
    ...(queue.length > 0 ? { queued: queue } : {}),
  }),
);

/** Реплика человека в переписку и новый ход — как `ProviderChatService.send`. */
function startTurn(text) {
  const message = {
    id: `u${messages.length}`,
    role: 'user',
    content: text,
    at: new Date().toISOString(),
  };
  messages.push(message);
  sent.push(text);
  isRunning = true;
  partial = '';
  return message;
}

await page.route('**/api/provider-chat/chats/qq1/send', async (route) => {
  const body = JSON.parse(route.request().postData() ?? '{}');
  if (isRunning && body.queueIfBusy) {
    const queued = {
      id: `q${queue.length + cancelled.length}`,
      text: body.text,
      at: new Date().toISOString(),
    };
    queue.push(queued);
    return json(route, { queued }, 202);
  }
  if (isRunning) {
    return json(
      route,
      { message: 'Ответ на предыдущий вопрос ещё идёт', messageCode: 'foreign-answer-running' },
      409,
    );
  }
  return json(route, { message: startTurn(body.text) });
});

await page.route('**/api/provider-chat/chats/qq1/queue/*', async (route) => {
  const id = route.request().url().split('/').pop();
  const before = queue.length;
  queue = queue.filter((item) => item.id !== id);
  if (queue.length < before) cancelled.push(id);
  return json(route, { cancelled: queue.length < before });
});

await page.route('**/api/provider-chat/chats/qq1', (route) =>
  json(route, { ...CHAT, messageCount: messages.length, messages }),
);

// Первый ответ печатается долго — за это время человек дописывает. По концу
// ответа «сервер» отпускает очередь: следующая реплика и новый ход.
await page.route('**/api/provider-chat/chats/qq1/stream', async (route) => {
  const number = ++answered;
  if (number === 1) {
    partial = 'Первый ответ печатается';
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
  const text = number === 1 ? 'Первый ответ готов' : `Ответ на «${sent.at(-1)}»`;
  messages.push({
    id: `a${messages.length}`,
    role: 'assistant',
    content: text,
    at: new Date().toISOString(),
    transport: 'stream',
  });
  isRunning = false;
  partial = '';
  const next = queue.shift();
  if (next) startTurn(next.text);
  const frames = [
    `data: ${JSON.stringify({ type: 'delta', text })}\n\n`,
    `data: ${JSON.stringify({ type: 'done' })}\n\n`,
  ];
  await route
    .fulfill({
      status: 200,
      headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' },
      body: frames.join(''),
    })
    .catch(() => {});
});

const errors = [];
page.on('console', (message) => {
  if (message.type() === 'error') errors.push(message.text());
});

await page.goto(`${BASE}/chat`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('nav');
await page.waitForTimeout(1500);

let bad = 0;
const check = (ok, text) => {
  console.log(`${ok ? '✓' : '✗'} ${text}`);
  if (!ok) bad += 1;
};

const composer = page.getByRole('textbox').last();
await composer.fill('Первый вопрос');
await page.getByRole('button', { name: 'Отправить' }).click();
await page.waitForTimeout(900);

const busyBox = page.getByRole('textbox', { name: /уйдёт, как только кончится ответ/ });
check(
  (await busyBox.count()) === 1,
  'пока идёт ответ, поле говорит, что дописанное уйдёт после него',
);
await busyBox.fill('Второй вопрос');
const queueButton = page.getByRole('button', { name: 'В очередь' });
check(await queueButton.isEnabled(), 'кнопка не заблокирована — «В очередь»');
await queueButton.click();
await page.waitForTimeout(500);
await busyBox.fill('Третий вопрос');
await queueButton.click();
await page.waitForTimeout(700);

const queuedBubbles = page.locator('[data-queued-message]');
check((await queuedBubbles.count()) === 2, 'оба дописанных — пузырями в ленте');
const busyText = await page.textContent('body');
check(
  busyText.includes('Уйдёт следующим') && busyText.includes('Уйдёт следом'),
  'подписано, что уйдёт следующим и что следом',
);
check(
  (await page.getByRole('button', { name: 'Остановить' }).count()) >= 1,
  'идущий ответ не прерван',
);
check(!sent.includes('Второй вопрос'), 'дописанное не ушло посреди ответа');

await queuedBubbles.nth(1).getByRole('button', { name: 'Убрать из очереди' }).click();
await page.waitForTimeout(500);
check((await queuedBubbles.count()) === 1, 'отменённое исчезло из ленты');
check(cancelled.length === 1 && queue.length === 1, 'и с сервера — очередь сервера без него');

await page.waitForTimeout(6000);
const after = await page.textContent('body');
check(after.includes('Первый ответ готов'), 'первый ответ допечатался');
check(sent.includes('Второй вопрос'), 'по концу ответа очередь ушла сама');
check(after.includes('Ответ на «Второй вопрос»'), 'ответ на дописанное пришёл без перезагрузки');
check(!sent.includes('Третий вопрос'), 'отменённое так и не ушло');
check((await queuedBubbles.count()) === 0, 'очередь пуста — пузырей нет');
check(errors.length === 0, `ошибок в консоли нет${errors.length ? `: ${errors[0]}` : ''}`);

await browser.close();
console.log(bad === 0 ? '\nВсе проверки прошли.' : `\nПровалено проверок: ${bad}`);
process.exit(bad === 0 ? 0 : 1);
