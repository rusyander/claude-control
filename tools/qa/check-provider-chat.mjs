/**
 * Прогон чата чужого провайдера.
 *
 * Настоящий CLI здесь не запускается и настройки панели НЕ переключаются:
 * активный провайдер и весь `/api/provider-chat/*` подменяются на лету. Иначе
 * прогон менял бы реальную конфигурацию пользователя и зависел от того, какой
 * CLI установлен на машине, — то есть был бы невоспроизводим.
 *
 * Проверяется то, ради чего этот чат сделан: разговоры в списке, ответ по мере
 * печати, остановка, и что переписка после ответа перечитывается.
 *
 * Запуск: `node tools/qa/check-provider-chat.mjs` при поднятом `pnpm dev`.
 */
import { chromium } from 'playwright';
import { bypassOnboarding } from './bypass-onboarding.mjs';

const BASE = process.env.APP_URL ?? 'http://localhost:8888';

const CHAT = {
  id: 'qa1',
  providerId: 'codex',
  title: 'Проверка',
  createdAt: '2026-08-02T10:00:00.000Z',
  updatedAt: '2026-08-02T10:00:00.000Z',
  messageCount: 0,
  // Разговор, заведённый разделением задач: панель подобрала модель под класс
  // работы (Т12) и обязана назвать её в шапке — подбор только ПОНИЖАЕТ, и
  // человек должен видеть, что чат идёт не тем, что настроено у CLI.
  model: 'gpt-5.3-codex-spark',
};

/** Переписка растёт по ходу прогона — как на настоящем сервере. */
const messages = [];
let isRunning = false;
let partial = '';

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
await bypassOnboarding(page);

const json = (route, body, status = 200) =>
  route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

// Активный провайдер — чужой. Подменяем ответ сервера, а не настройки на диске.
await page.route('**/api/settings', async (route) => {
  if (route.request().method() !== 'GET') return route.continue();
  const response = await route.fetch();
  const settings = await response.json();
  await route.fulfill({ response, json: { ...settings, provider: 'codex' } });
});

await page.route('**/api/provider-runner', (route) =>
  json(route, { providerId: 'codex', providerName: 'Codex', mode: 'cli' }),
);

await page.route('**/api/provider-chat/chats', (route) =>
  json(route, [{ ...CHAT, messageCount: messages.length }]),
);

await page.route('**/api/provider-chat/chats/qa1/status', (route) =>
  json(route, { chatId: 'qa1', isRunning, partial }),
);

await page.route('**/api/provider-chat/chats/qa1/send', async (route) => {
  const body = JSON.parse(route.request().postData() ?? '{}');
  const message = {
    id: `u${messages.length}`,
    role: 'user',
    content: body.text,
    at: new Date().toISOString(),
  };
  messages.push(message);
  isRunning = true;
  partial = '';
  await json(route, { message });
});

await page.route('**/api/provider-chat/chats/qa1/stop', async (route) => {
  isRunning = false;
  await json(route, { stopped: true });
});

let deleted = false;
await page.route('**/api/provider-chat/chats/qa1', async (route) => {
  if (route.request().method() === 'DELETE') {
    deleted = true;
    return json(route, { ok: true });
  }
  return json(route, { ...CHAT, messageCount: messages.length, messages });
});

// Время ответов: у чужого CLI его меряет сама панель по своему прогону, и в
// ленте под ответом стоят шаг и сумма по разговору. Здесь числа заданы, чтобы
// проверять текст, а не часы машины.
const DURATIONS = [4200, 72_000];
let answered = 0;

// Поток ответа: куски идут с паузами — ровно так его печатает настоящий CLI.
await page.route('**/api/provider-chat/chats/qa1/stream', async (route) => {
  const chunks = ['Первая ', 'часть ', 'ответа'];
  const frames = chunks.map((text) => `data: ${JSON.stringify({ type: 'delta', text })}\n\n`);
  partial = chunks.join('');
  messages.push({
    id: `a${messages.length}`,
    role: 'assistant',
    content: partial,
    at: new Date().toISOString(),
    transport: 'stream',
    durationMs: DURATIONS[answered++ % DURATIONS.length],
  });
  isRunning = false;
  const done = `data: ${JSON.stringify({ type: 'done' })}\n\n`;
  await route.fulfill({
    status: 200,
    headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' },
    body: `${frames.join('')}${done}`,
  });
});

/**
 * Чем прогон пойдёт через контур (Т6). Разговор просит `gpt-5.3-codex-spark` —
 * имени контура он не знает, в каталоге контура его нет, и запрос уйдёт с
 * моделью контура. Шапка обязана сказать это словом: метка с чужим именем
 * читается как «идём этой моделью», а идём мы другой.
 */
let routedPlan = {
  routed: true,
  title: 'Company · dev',
  rules: {
    model: 'company-mid',
    source: 'default',
    map: {},
    catalog: ['company-mid', 'company-large'],
  },
  effort: false,
};
await page.route('**/api/platform-run-plan/**', (route) => json(route, routedPlan));

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

const body = await page.textContent('body');
check(body.includes('Разговоры'), 'открылся чат чужого провайдера, а не чат Claude');
check(body.includes('Проверка'), 'разговор виден в списке');
check(body.includes('gpt-5.3-codex-spark'), 'подобранная панелью модель названа в шапке');
// Т6: через контур выбор разговора — просьба. Подмена названа вслух, вместе с
// тем, что уедет на самом деле.
check(
  body.includes('company-mid') && body.includes('Company · dev'),
  'сказано, чем разговор пойдёт через контур на самом деле',
);
check(
  body.includes('не принимает глубину продумывания'),
  'потерянная глубина названа и в шапке чужого чата',
);

const composer = page.getByRole('textbox', { name: /Сообщение провайдеру/ });
check((await composer.count()) === 1, 'поле ввода на месте');

await composer.fill('Привет');
await page.getByRole('button', { name: 'Отправить' }).click();
await page.waitForTimeout(1500);

const afterSend = await page.textContent('body');
check(afterSend.includes('Привет'), 'своя реплика видна в ленте');
check(afterSend.includes('Первая часть ответа'), 'ответ пришёл потоком и виден целиком');
check(afterSend.includes('поток CLI'), 'способ ответа помечен');
check(afterSend.includes('Ответ шёл 4с'), 'под первым ответом стоит время шага');
check(
  !afterSend.includes('всего по разговору'),
  'суммы по разговору у единственного ответа нет: она равна шагу',
);

// Второй вопрос: переписка должна помнить первый.
await composer.fill('Второй вопрос');
await page.getByRole('button', { name: 'Отправить' }).click();
await page.waitForTimeout(1500);

const afterSecond = await page.textContent('body');
check(afterSecond.includes('Привет'), 'первый вопрос остался в переписке');
check(afterSecond.includes('Второй вопрос'), 'второй вопрос виден');
check(
  afterSecond.includes('Ответ шёл 1м 12с, всего по разговору 1м 16с'),
  'у второго ответа время шага и сумма по разговору',
);

// Ответ ревьюера из конвейера звеньев: блок вердикта служебный — по нему панель
// заводит правки, а человеку в ленте нужен разбор словами. У Claude блок убирает
// `MessageBubble`, у чужого чата своя лента, и до 08.09.2026 она показывала
// сырой JSON.
messages.push({
  id: 'a-review',
  role: 'assistant',
  content: [
    'Прочитал дифф и задание. Два пункта требуют правки.',
    '',
    '```agentdeck:review',
    JSON.stringify({ findings: ['src/read.ts: пустой ввод не обработан'] }),
    '```',
  ].join('\n'),
  at: new Date().toISOString(),
  transport: 'stream',
});
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForSelector('nav');
await page.waitForTimeout(1500);

const afterReview = await page.textContent('body');
check(afterReview.includes('Два пункта требуют правки'), 'слова ревьюера остались человеку');
check(
  !afterReview.includes('agentdeck:review') && !afterReview.includes('"findings"'),
  'служебный блок вердикта в ленте не показывается',
);
// Реплика без времени — запись, сделанная до появления поля. Строки времени у
// неё нет вовсе: выдуманный ноль хуже пустого места.
check(
  afterReview.split('Ответ шёл').length - 1 === 2,
  'реплика без записанного времени строки времени не получает',
);

// Разговор НЕ через контур обязан вернуть шапку к прежнему виду: метка «запрос
// уйдёт с другой моделью» в обычном чате — ложь о том, чего не происходит.
routedPlan = {
  routed: false,
  title: '',
  reason: 'consumer_off',
  rules: { model: '', source: 'none', map: {}, catalog: [] },
  effort: true,
};
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForSelector('nav');
await page.waitForTimeout(1500);
const offContour = await page.textContent('body');
check(!offContour.includes('company-mid'), 'без контура метки модели контура нет вовсе');
check(
  !offContour.includes('не принимает глубину продумывания'),
  'без контура о глубине шапка ничего не утверждает',
);
check(offContour.includes('gpt-5.3-codex-spark'), 'своя метка модели при этом на месте');

// Удаление разговора спрашивает подтверждение: переписка исчезает с диска.
await page.getByRole('button', { name: 'Удалить' }).first().click();
await page.waitForTimeout(600);
check(!deleted, 'удаление не выполняется до подтверждения');

const confirm = page.getByRole('dialog');
check((await confirm.count()) === 1, 'спрошено подтверждение');
await confirm.getByRole('button', { name: 'Удалить' }).click();
await page.waitForTimeout(800);
check(deleted, 'после подтверждения разговор удалён');

check(errors.length === 0, `ошибок в консоли нет${errors.length ? `: ${errors[0]}` : ''}`);

await browser.close();
console.log(bad === 0 ? '\nВсе проверки прошли.' : `\nПровалено проверок: ${bad}`);
process.exit(bad === 0 ? 0 : 1);
