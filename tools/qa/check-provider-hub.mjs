/**
 * Хаб родителя, дерево и его пауза у чужого провайдера (Т2 и Т5 партии
 * «автономия у чужих CLI»).
 *
 * Настоящий CLI не запускается и настройки панели НЕ переключаются: активный
 * провайдер, список разговоров и дерево подменяются на лету — иначе прогон
 * зависел бы от того, какой CLI установлен, и правил бы конфигурацию человека.
 *
 * Проверяется ровно то, ради чего фундамент и делался: у чужого родителя есть
 * дерево, оно спрашивается ИМЕНОВАННЫМ ключом (`codex:qa1`), в ленте стоит хаб
 * с детьми, их звеньями и состоянием, а звено открывается на этой же странице
 * чужого чата, а не на странице Claude. Плюс пауза дерева: «Остановить всё» и
 * «Продолжить всё» теми же маршрутами, и подпись, не обещающая продолжения
 * сессии там, где сессии не существует.
 *
 * Запуск: `node tools/qa/check-provider-hub.mjs` при поднятом `pnpm dev`.
 */
import { chromium } from 'playwright';
import { bypassOnboarding } from './bypass-onboarding.mjs';

const BASE = process.env.APP_URL ?? 'http://localhost:8888';

const at = '2026-09-09T10:00:00.000Z';
const chatOf = (id, title, text) => ({
  id,
  providerId: 'codex',
  title,
  createdAt: at,
  updatedAt: at,
  messageCount: 1,
  messages: [{ id: `${id}-m1`, role: 'assistant', content: text, at, transport: 'stream' }],
});

// Родитель первым: страница открывает первый разговор списка сама.
const CHATS = [
  chatOf('qa1', 'Родитель', 'Делю задачу на группы.'),
  chatOf('kid1', 'Чтение · работа', 'Работаю над чтением.'),
  chatOf('kid2', 'Запись · план', 'Составляю план записи.'),
];

/** Пересечение веток (Т4): считается по концу цепочки и по кнопке в хабе. */
const OVERLAP = {
  at: '2026-09-09T12:30:00.000Z',
  files: [{ path: 'shared.ts', groups: [0, 1], outside: [1] }],
  mergeOrder: [0, 1],
  counted: [
    { index: 0, files: 2 },
    { index: 1, files: 2 },
  ],
  unread: [],
};

/** Запись конвейера уровней: из неё хаб берёт названия групп для сверки. */
const SPLIT = {
  parentChatId: 'codex:qa1',
  order: [0, 1],
  groups: [
    { index: 0, title: 'Чтение', branch: 'split/read', after: [], status: 'started' },
    { index: 1, title: 'Запись', branch: 'split/write', after: [], status: 'started' },
  ],
};

/** Дерево родителя: две группы, у первой пройден план и идёт работа. */
const TREE = {
  root: 'codex:qa1',
  split: SPLIT,
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
      title: 'Запись · план',
      branch: 'split/write',
      stage: 'plan',
      running: false,
    },
  ],
};

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
await bypassOnboarding(page);

const json = (route, body, status = 200) =>
  route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

// Активный провайдер — чужой. Подменяем ответ сервера, а не настройки на диске.
await page.route('**/api/settings', async (route) => {
  if (route.request().method() !== 'GET') return route.continue();
  const response = await route.fetch();
  // Тело бывает пустым: стенд перезапускается (`node --watch`) или отвечает 304
  // на условный запрос. Падать здесь стеком нельзя — прогон соврал бы про
  // причину: он не сломался, он не дождался стенда.
  const text = await response.text();
  if (!text) {
    console.log('✗ стенд не ответил настройками — поднимите `pnpm dev` и повторите');
    process.exit(1);
  }
  await route.fulfill({ response, json: { ...JSON.parse(text), provider: 'codex' } });
});

await page.route('**/api/provider-runner', (route) =>
  json(route, { providerId: 'codex', providerName: 'Codex', mode: 'cli' }),
);

await page.route('**/api/provider-chat/chats', (route) =>
  json(
    route,
    CHATS.map(({ messages, ...card }) => ({ ...card, messageCount: messages.length })),
  ),
);

await page.route('**/api/provider-chat/chats/*', (route) => {
  const id = new URL(route.request().url()).pathname.split('/').pop();
  const chat = CHATS.find((item) => item.id === id);
  return chat ? json(route, chat) : json(route, { error: 'нет разговора' }, 404);
});

await page.route('**/api/provider-chat/chats/*/status', (route) => {
  const id = new URL(route.request().url()).pathname.split('/').at(-2);
  return json(route, { chatId: id, isRunning: false, partial: '' });
});

/** Каким ключом спрашивали дерево — главный вопрос этого прогона. */
const treeKeys = [];
/** Дерево стоит: после «Остановить всё» тот же ответ приходит с записью паузы. */
let paused = false;
/** Сверку уже считали — тогда дерево несёт её итог. */
let counted = false;
await page.route('**/api/chat/*/tree', (route) => {
  const key = decodeURIComponent(new URL(route.request().url()).pathname.split('/').at(-2));
  treeKeys.push(key);
  // У ребёнка дерево НЕ пустое: сервер поднимается по связям вверх, до
  // разговора без родителя, и отвечает деревом РОДИТЕЛЯ — тем же самым. Пустая
  // подстановка прятала бы ровно то, что здесь и проверяется: хаб рисуется
  // только у корня, а не у всякого, кому дерево ответило.
  const split = counted ? { ...SPLIT, overlap: OVERLAP } : SPLIT;
  return json(
    route,
    paused
      ? {
          ...TREE,
          split,
          running: 0,
          paused: { at: '2026-09-09T12:00:00.000Z', chats: 1, pending: 1 },
        }
      : { ...TREE, split },
  );
});

/** Пауза и продолжение дерева — те же маршруты, что у Claude. */
const treeCalls = [];
await page.route('**/api/chat/*/tree/pause', (route) => {
  treeCalls.push('pause');
  paused = true;
  return json(route, { root: 'codex:qa1', stopped: 1, chats: 1, alreadyPaused: false });
});
await page.route('**/api/chat/*/tree/resume', (route) => {
  treeCalls.push('resume');
  paused = false;
  return json(route, { root: 'codex:qa1', wasPaused: true, resumed: 1, flushed: 1 });
});

/**
 * Сверка веток (Т4): считает её сервер, и здесь важно ровно две вещи — каким
 * ключом её просили и что счёт приезжает деревом, а не ответом на нажатие.
 */
const overlapKeys = [];
await page.route('**/api/chat/split/*/overlap', (route) => {
  overlapKeys.push(decodeURIComponent(new URL(route.request().url()).pathname.split('/').at(-2)));
  counted = true;
  return json(route, OVERLAP);
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

const body = await page.textContent('body');
check(body.includes('Разговоры'), 'открылся чат чужого провайдера, а не чат Claude');
check(
  treeKeys.includes('codex:qa1'),
  `дерево спрошено именованным ключом${treeKeys.length ? `: ${treeKeys.join(', ')}` : ' — запроса не было'}`,
);
check(
  !treeKeys.includes('qa1'),
  '«голым» идентификатором дерево не спрашивается: пространства ключей разные',
);

const hub = page.locator('[data-child-hub]');
check((await hub.count()) === 1, 'хаб родителя стоит в ленте');
const hubText = (await hub.count()) ? await hub.textContent() : '';
check(hubText.includes('Группы разделения: 2'), 'групп в хабе столько, сколько веток у детей');
check(
  hubText.includes('split/read') && hubText.includes('split/write'),
  'у каждой группы названа её ветка',
);
check(hubText.includes('план › работа'), 'пройденные звенья группы подписаны подряд');

const rows = hub.locator('[data-hub-row="chat"]');
check((await rows.count()) === 2, 'обе группы — строки, которые можно открыть');
check(
  (await rows.nth(0).locator('[aria-label="идёт прогон"]').count()) === 1,
  'у работающей группы точка состояния говорит «идёт прогон»',
);
check(
  (await rows.nth(1).locator('[aria-label="прогон не идёт"]').count()) === 1,
  'у молчащей группы — «прогон не идёт»',
);

// Пауза дерева (Т5): кнопка есть, пока что-то идёт; после неё — «Продолжить
// всё», и подпись говорит правду про чужой CLI — сессии у него нет.
const pauseButton = hub.getByRole('button', { name: /Остановить всё/ });
check((await pauseButton.count()) === 1, 'у идущего дерева есть «Остановить всё»');
await pauseButton.click();
await page.waitForTimeout(1200);
check(treeCalls.includes('pause'), 'нажатие дошло до сервера');

const resumeButton = page
  .locator('[data-child-hub]')
  .getByRole('button', { name: /Продолжить всё/ });
check((await resumeButton.count()) === 1, 'у стоящего дерева — «Продолжить всё»');
check(
  (await resumeButton.getAttribute('title'))?.includes('сессии у этого CLI нет'),
  'подпись не обещает продолжения сессии, которой у чужого CLI нет',
);
check(
  (await page.locator('[data-child-hub]').textContent()).includes('на паузе'),
  'хаб говорит, что дерево стоит',
);
await resumeButton.click();
await page.waitForTimeout(1200);
check(treeCalls.includes('resume'), 'продолжение дошло до сервера');
check(
  (await page
    .locator('[data-child-hub]')
    .getByRole('button', { name: /Остановить всё/ })
    .count()) === 1,
  'после продолжения кнопка снова останавливает',
);

// Звено открывается ЗДЕСЬ же: у чужого чата вкладок копий нет, а страница
// Claude о его разговорах не знает вовсе.
await rows.nth(0).click();
await page.waitForTimeout(1200);

const afterOpen = await page.textContent('body');
check(afterOpen.includes('Работаю над чтением'), 'открылась переписка звена');
check(new URL(page.url()).pathname === '/chat', 'звено открыто на странице чужого чата');
check(treeKeys.includes('codex:kid1'), 'дерево звена спрошено его собственным именованным ключом');
check((await page.locator('[data-child-hub]').count()) === 0, 'у звена без детей хаба нет');

/**
 * Сверка веток у чужих групп (Т4). До нажатия панель не утверждает ничего —
 * «не сверялись»; счёт приезжает деревом, и красным помечается ТОЛЬКО файл вне
 * объявленных владений группы.
 */
await page.goto(`${BASE}/chat`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1500);
const overlapPanel = page.locator('[data-hub-overlap]');
check((await overlapPanel.count()) === 1, 'раздел пересечений есть и у чужого хаба');
check(
  (await overlapPanel.getAttribute('data-hub-overlap')) === 'idle',
  'до сверки панель не утверждает, что пересечений нет',
);

const checkButton = page.getByRole('button', { name: 'Сверить ветки' });
check((await checkButton.count()) === 1, 'кнопка «Сверить ветки» на месте');
await checkButton.click();
await page.waitForTimeout(1500);
check(
  overlapKeys.includes('codex:qa1'),
  `сверка спрошена именованным ключом родителя: ${JSON.stringify(overlapKeys)}`,
);
check(
  (await overlapPanel.getAttribute('data-hub-overlap')) === 'checked',
  'после сверки раздел показывает счёт, а не прежнее «не сверялись»',
);
const overlapText = await overlapPanel.textContent();
check(overlapText.includes('shared.ts'), `общий файл назван: ${overlapText}`);
check(
  overlapText.includes('вне владения: Запись'),
  'нарушителем названа только группа, у которой файл вне владений',
);
check(
  (await page.locator('[data-overlap-file="outside"]').count()) === 1,
  'красная строка ровно одна — файл вне владений',
);

check(errors.length === 0, `ошибок в консоли нет${errors.length ? `: ${errors[0]}` : ''}`);

await browser.close();
console.log(bad === 0 ? '\nВсе проверки прошли.' : `\nПровалено проверок: ${bad}`);
process.exit(bad === 0 ? 0 : 1);
