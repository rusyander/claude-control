/**
 * Ревью запросов на слияние по ссылке у чужого провайдера (Т6 партии
 * «автономия у чужих CLI»).
 *
 * Настоящий CLI не запускается и настройки панели НЕ переключаются: активный
 * провайдер, список разговоров и дерево подменяются на лету — иначе прогон
 * зависел бы от того, какой CLI установлен, и правил бы конфигурацию человека.
 *
 * Проверяется ровно то, чем эта штука может навредить или молча ничего не
 * сделать: карточка решения у чужого родителя есть и она одна на группу; «ко
 * всем» считается по соседям, а не по себе; запись в чужой MR уходит только по
 * клику и только тем маршрутом; выключенная интеграция гасит кнопку С ПРИЧИНОЙ,
 * а не молча; в ленте самой группы стоит её собственная карточка и НЕ стоит
 * пульт всего разделения.
 *
 * Дерево у ребёнка тут отвечает деревом РОДИТЕЛЯ — как отвечает сервер: он
 * поднимается по связям вверх, до разговора без родителя. Подстановка пустого
 * дерева прятала бы ровно ту разницу, ради которой этот прогон и написан.
 *
 * Запуск: `node tools/qa/check-provider-review.mjs` при поднятом `pnpm dev`.
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
  chatOf('qa1', 'Разделение', 'Разделил ревью по группам.'),
  chatOf('mr1', 'MR 42', 'Посмотрел дифф MR 42.'),
  chatOf('mr2', 'MR 43', 'Посмотрел дифф MR 43.'),
  chatOf('mr3', 'MR 44', 'Правки по замечаниям сделаны.'),
  chatOf('mr4', 'MR 45', 'Посмотрел дифф MR 45.'),
];

const URL42 = 'https://gitlab.com/team/app/-/merge_requests/42';
const URL43 = 'https://gitlab.com/team/app/-/merge_requests/43';
const URL44 = 'https://gitlab.com/team/app/-/merge_requests/44';
const URL45 = 'https://gitlab.com/team/app/-/merge_requests/45';
/** Почему «Отписать в MR» недоступно: панель обязана назвать причину. */
const BLOCKED = 'интеграция с форджем выключена в настройках панели';

const node = (id, title, branch, review) => ({
  chatId: `codex:${id}`,
  aliases: [],
  parentChatId: 'codex:qa1',
  title,
  branch,
  stage: review.pushedAt || review.decidedAt ? 'fix' : 'review',
  running: false,
  review,
});

/**
 * Дерево родителя: три группы ждут решения и одна уже решена — у неё правки
 * сделаны, и панель предлагает отправить их в MR отдельным кликом.
 */
const tree = (decided) => ({
  root: 'codex:qa1',
  running: 0,
  nodes: [
    node('mr1', 'MR 42', 'feature/login', {
      url: URL42,
      branch: 'feature/login',
      findings: ['src/auth.ts:10 — забыт await', 'src/auth.ts:42 — пароль в логе'],
      postBlocked: BLOCKED,
      ...(decided.has('codex:mr1')
        ? { decision: 'fix', decidedAt: '2026-09-09T12:00:00.000Z' }
        : {}),
    }),
    node('mr2', 'MR 43', 'feature/export', {
      url: URL43,
      branch: 'feature/export',
      findings: ['src/export.ts:7 — нет теста'],
      postBlocked: BLOCKED,
      ...(decided.has('codex:mr2')
        ? { decision: 'none', decidedAt: '2026-09-09T12:05:00.000Z' }
        : {}),
    }),
    node('mr3', 'MR 44', 'feature/cache', {
      url: URL44,
      branch: 'feature/cache',
      findings: ['src/cache.ts:3 — гонка'],
      decision: 'fix',
      decidedAt: '2026-09-09T11:00:00.000Z',
      pushOffer: true,
    }),
    node('mr4', 'MR 45', 'feature/import', {
      url: URL45,
      branch: 'feature/import',
      findings: ['src/import.ts:1 — молчащий catch'],
      postBlocked: BLOCKED,
      ...(decided.has('codex:mr4')
        ? { decision: 'none', decidedAt: '2026-09-09T12:05:00.000Z' }
        : {}),
    }),
  ],
});

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
await bypassOnboarding(page);

const json = (route, body, status = 200) =>
  route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

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
    CHATS.map(({ messages, ...summary }) => ({ ...summary, messageCount: messages.length })),
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

/** Решённые группы: дерево возвращает их карточки принятыми, как и сервер. */
const decided = new Set();
const treeKeys = [];
await page.route('**/api/chat/*/tree', (route) => {
  const key = decodeURIComponent(new URL(route.request().url()).pathname.split('/').at(-2));
  treeKeys.push(key);
  // Сервер поднимается по связям ВВЕРХ: у любого ключа дерева корень один и
  // тот же. Ребёнку приезжает дерево родителя — и так и должно быть.
  return json(route, tree(decided));
});

/** Решения и отправка: сюда уходит клик, и больше никуда. */
const decisions = [];
await page.route('**/api/chat/split/*/review-decision', (route) => {
  const parent = decodeURIComponent(new URL(route.request().url()).pathname.split('/').at(-2));
  const body = route.request().postDataJSON();
  decisions.push({ parent, ...body });
  // «Ко всем» решает и соседок — ровно так же, как это делает домен.
  const touched = body.all
    ? tree(decided)
        .nodes.filter((item) => (item.review.findings ?? []).length > 0 && !item.review.decidedAt)
        .map((item) => item.chatId)
    : [body.chatId];
  for (const key of touched) decided.add(key);
  return json(route, {
    applied: touched.map((chatId) => ({ chatId, decision: body.decision })),
    skipped: [],
  });
});

const pushes = [];
await page.route('**/api/chat/split/*/review-push', (route) => {
  const parent = decodeURIComponent(new URL(route.request().url()).pathname.split('/').at(-2));
  pushes.push({ parent, ...route.request().postDataJSON() });
  return json(route, {
    applied: [{ chatId: 'codex:mr3', pushChatId: 'codex:push1' }],
    skipped: [],
  });
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

const cards = page.locator('[data-review-card]');
check(
  (await cards.count()) === 4,
  `у родителя карточка на каждую ревью-группу: ${await cards.count()}`,
);
check(
  (await page.locator('[data-review-card="waiting"]').count()) === 3,
  'решения ждут ровно те группы, по которым его ещё не приняли',
);

const first = cards.first();
const firstText = await first.textContent();
check(firstText.includes(URL42), 'карточка называет ссылку целиком — по ней человек и уходит');
check(firstText.includes('забыт await'), 'замечания видны в самой карточке');
check(firstText.includes('feature/login'), 'сказано, на какой ветке стоит копия');

// Выключенная интеграция гасит запись в MR — но кнопка не исчезает молча:
// человек читает причину и чинит настройку.
const post = first.getByRole('button', { name: 'Отписать в MR' });
check(await post.isDisabled(), 'без интеграции «Отписать в MR» недоступно');
check(
  (await post.getAttribute('title')) === BLOCKED,
  `на кнопке названа причина: ${await post.getAttribute('title')}`,
);
check(
  await first.getByRole('button', { name: 'Починить в копии' }).isEnabled(),
  'правки в СВОЕЙ копии интеграции не требуют — кнопка живая',
);

// «Ко всем» считается по соседям: своя карточка в счёт не идёт.
check(
  (await first.getByText('то же решение ещё 2 группам').count()) === 1,
  'тумблер «ко всем» назвал соседок, но не саму карточку',
);

// Решённая карточка остаётся на месте: по ней вспоминают, что выбрали.
const third = cards.nth(2);
const thirdText = await third.textContent();
check(thirdText.includes('Решено: чиним в копии'), 'решённая карточка помнит выбор');
check(
  (await third.getByRole('button', { name: 'Починить в копии' }).count()) === 0,
  'перерешать нечего: кнопок выбора у решённой карточки нет',
);

// Отправка правок в чужую ветку — второй, отдельный клик.
const pushButton = third.getByRole('button', { name: 'Закоммитить и отправить в MR' });
check((await pushButton.count()) === 1, 'после правок панель предлагает отправить их в MR');
await pushButton.click();
await page.waitForTimeout(1200);
check(
  pushes.length === 1 && pushes[0].chatId === 'codex:mr3' && pushes[0].parent === 'codex:qa1',
  `отправка ушла своим маршрутом и своим ключом: ${JSON.stringify(pushes)}`,
);

// Решение: клик по «Починить в копии» без тумблера — только эта группа.
await first.getByRole('button', { name: 'Починить в копии' }).click();
await page.waitForTimeout(1500);
check(
  decisions.length === 1 &&
    decisions[0].chatId === 'codex:mr1' &&
    decisions[0].decision === 'fix' &&
    decisions[0].parent === 'codex:qa1',
  `решение ушло с ключом группы и деревом родителя: ${JSON.stringify(decisions)}`,
);
check(decisions[0].all !== true, '«ко всем» не уехало само: тумблер человек не трогал');
check(
  (await page.locator('[data-review-card="decided"]').count()) === 2,
  'после ответа карточка стала решённой — состояние приехало деревом',
);

// «Ко всем»: включённый тумблер уезжает вместе с решением и закрывает соседок.
const waiting = page.locator('[data-review-card="waiting"]').first();
await waiting.getByRole('switch').click();
await waiting.getByRole('button', { name: 'Ничего не делать' }).click();
await page.waitForTimeout(1500);
check(
  decisions.at(-1)?.all === true && decisions.at(-1)?.decision === 'none',
  `включённый тумблер уехал вместе с решением: ${JSON.stringify(decisions.at(-1))}`,
);
check(
  (await page.locator('[data-review-card="waiting"]').count()) === 0,
  'решение «ко всем» закрыло и соседку — ждущих карточек не осталось',
);

/**
 * Лента самой группы. Здесь главное — то, чего быть НЕ должно: пульт всего
 * разделения. Дерево у ребёнка то же самое, что у родителя, и без проверки
 * корня группа показывала бы решения соседей, которых человек не смотрел.
 */
await page.goto(`${BASE}/chat`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1500);
await page.getByRole('button', { name: 'MR 42' }).first().click();
await page.waitForTimeout(1500);

const own = await page.textContent('body');
check(own.includes('Посмотрел дифф MR 42'), 'открылась переписка ревью-группы');
check(
  (await page.locator('[data-child-hub]').count()) === 0,
  'в ленте группы нет хаба родителя: пульт разделения — не её дело',
);
const ownCards = page.locator('[data-review-card]');
check(
  (await ownCards.count()) === 1,
  `в ленте группы ровно одна карточка: ${await ownCards.count()}`,
);
check(
  (await ownCards.first().textContent()).includes(URL42),
  'и это её собственное ревью, а не соседкино',
);

check(errors.length === 0, `ошибок в консоли нет${errors.length ? `: ${errors[0]}` : ''}`);

await browser.close();
console.log(bad === 0 ? '\nВсе проверки прошли.' : `\nПровалено проверок: ${bad}`);
process.exit(bad === 0 ? 0 : 1);
