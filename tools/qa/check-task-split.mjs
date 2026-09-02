/**
 * Прогон разделения задач по чатам.
 *
 * Проверяется то, из-за чего эта штука способна навредить: что вместо блока с
 * JSON человек видит карточку с составом групп, что отказ — такой же законный
 * ход, как согласие, и что «только завести чаты» действительно доезжает до
 * сервера, а не теряется по дороге (иначе вместо четырёх заготовок разом
 * стартуют четыре агента).
 *
 * Данные подменяются целиком: ни настоящих копий репозитория, ни запущенных
 * агентов прогон не создаёт — иначе он оставлял бы за собой ветки на машине.
 *
 * Запуск: `node tools/qa/check-task-split.mjs` при поднятом `pnpm dev`.
 */
import { chromium } from 'playwright';
import { bypassOnboarding } from './bypass-onboarding.mjs';

const BASE = process.env.APP_URL ?? 'http://localhost:8888';
const CHAT_ID = 'qa-split-chat';
/** Каталога на диске нет: ни копий, ни веток прогон за собой не оставляет. */
const PROJECT = { name: 'QA разделение', path: 'C:/qa-split-project' };

const PROPOSAL = {
  shared: 'Общий контекст: панель на React, правки в apps/web.',
  groups: [
    {
      title: 'Форма входа',
      branch: 'feature/login',
      tasks: ['починить валидацию', 'убрать двойную отправку'],
    },
    { title: 'Шапка', branch: 'feature/header', tasks: ['выровнять отступы'] },
  ],
};

const block = (json) => ['```claude-control:split', JSON.stringify(json), '```'].join('\n');

const CHAT = {
  id: CHAT_ID,
  title: 'Разделение задач',
  project: PROJECT.name,
  projectPath: PROJECT.path,
  isSandbox: false,
  messageCount: 2,
  createdAt: '2026-09-01T10:00:00.000Z',
  updatedAt: '2026-09-01T10:05:00.000Z',
  preview: 'Предлагаю разделить',
};

const MESSAGES = {
  messages: [
    {
      id: 'm-old',
      role: 'assistant',
      blocks: [{ type: 'text', text: `Старое предложение.\n\n${block(PROPOSAL)}` }],
      timestamp: '2026-09-01T10:01:00.000Z',
    },
    {
      id: 'm-last',
      role: 'assistant',
      blocks: [{ type: 'text', text: `Задачи независимы.\n\n${block(PROPOSAL)}\n\nЖду решения.` }],
      timestamp: '2026-09-01T10:05:00.000Z',
    },
  ],
  total: 2,
  hasMore: false,
};

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
await bypassOnboarding(page);

const errors = [];
page.on('console', (message) => {
  if (message.type() === 'error') errors.push(message.text().slice(0, 200));
});

/** Что ушло на сервер: по этому и судим, а не по виду кнопок. */
let sent;
let splitBody;
/** Отказ от разделения: он же гасит инициативу разговора. */
let declined;

// Каталога проекта на диске нет — настоящий git-пульт ответил бы отказом и
// засорил консоль. Проверяем не его, поэтому отвечаем «не репозиторий».
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
        lastActivity: '2026-09-01T10:00:00.000Z',
        chats: [],
      },
    ],
  }),
);

await page.route('**/api/chats', (route) => route.fulfill({ json: [CHAT] }));
await page.route(`**/api/chats/${CHAT_ID}/messages*`, (route) => route.fulfill({ json: MESSAGES }));
await page.route('**/api/chat/active', (route) => route.fulfill({ json: [] }));
await page.route(`**/api/chat/${CHAT_ID}/progress*`, (route) =>
  route.fulfill({ json: { steps: [], isComplete: false } }),
);
await page.route(`**/api/chat/${CHAT_ID}/artifacts*`, (route) => route.fulfill({ json: [] }));

await page.route('**/api/chat/send', (route) => {
  sent = route.request().postDataJSON();
  return route.fulfill({
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
    body: 'data: {"type":"done","seq":1}\n\n',
  });
});

// Текст просьбы отдаёт сервер — второй копии инструкции в клиенте быть не должно.
await page.route('**/api/chat/split/request', (route) =>
  route.fulfill({ json: { prompt: 'Разбей задачи блоком claude-control:split.' } }),
);

// Отказ гасит инициативу разговора на сервере: реплика живёт один ход, а
// инструкция «предложи разделение» дописывается к КАЖДОМУ прогону — без отметки
// следующий же предложил бы то же самое, и так до бесконечности.
await page.route('**/api/chat/split/decline', (route) => {
  declined = route.request().postDataJSON();
  return route.fulfill({ json: { ok: true } });
});

await page.route('**/api/chat/split', (route) => {
  splitBody = route.request().postDataJSON();
  return route.fulfill({
    json: {
      chats: splitBody.proposal.groups.map((group, index) => ({
        chatId: `new-1-${index}`,
        title: group.title,
        branch: group.branch,
        path: `${PROJECT.path}-worktrees/${group.branch.replace(/\//g, '-')}`,
        prompt: group.tasks.join('\n'),
        started: Boolean(splitBody.startRuns),
        isWorktree: true,
      })),
      failures: [],
    },
  });
});

await page.goto(`${BASE}/chat`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('nav');
await page.waitForTimeout(1200);

let bad = 0;
const check = (ok, text) => {
  console.log(`${ok ? 'ок  ' : 'ПЛОХО'} ${text}`);
  if (!ok) bad += 1;
};

// Делить нечего, пока не открыт проект: в песочнице ни копий, ни веток.
check(
  (await page.getByRole('button', { name: 'Разделить задачи по чатам' }).count()) === 0,
  'в песочнице кнопки разделения нет',
);

// Список проектов живёт за сегментом «Проекты» — по умолчанию там чаты.
await page.getByRole('tab', { name: 'Проекты' }).click();
await page.waitForTimeout(800);
await page
  .getByRole('button', { name: new RegExp(PROJECT.name) })
  .first()
  .click();
await page.waitForTimeout(1200);
await page
  .getByRole('button', { name: /Разделение задач/ })
  .first()
  .click();
await page.waitForTimeout(1500);

const body = await page.textContent('body');
check(!body.includes('claude-control:split'), 'сырого блока в ленте нет');
check(!body.includes('"branch"'), 'JSON предложения не показан как текст');
check(body.includes('Задачи независимы') && body.includes('Жду решения'), 'текст вокруг блока цел');
check(body.includes('feature/login') && body.includes('feature/header'), 'ветки групп видны');
check(body.includes('починить валидацию'), 'задачи группы перечислены');
check(body.includes('Общий контекст'), 'общий контекст показан');

// Решение принимают только по последнему предложению: карточка из середины
// истории отработана, заводить по ней ветки десять ходов спустя никто не просил.
const apply = page.getByRole('button', { name: 'Разделить на 2 чата' });
check((await apply.count()) === 1, 'кнопки только у последнего предложения');

/** Пока идёт ход, карточка погашена: ждём конца хода, а не таймаута клика. */
const waitEnabled = async (locator) => {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if ((await locator.count()) > 0 && (await locator.first().isEnabled())) return true;
    await page.waitForTimeout(250);
  }
  return false;
};

// Отказ — такой же ход, как согласие: уходит агенту обычной репликой.
await page.getByRole('button', { name: 'Делать здесь по очереди' }).click();
await page.waitForTimeout(1500);
check(sent?.prompt?.includes('Не разделяй'), 'отказ ушёл репликой в тот же разговор');
check(splitBody === undefined, 'отказ не заводит ни чатов, ни веток');
check(
  declined?.chatId === CHAT_ID,
  `отказ погасил инициативу этого разговора: ${JSON.stringify(declined)}`,
);
check((await apply.count()) === 0, 'после ответа предложение отработано: кнопок нет');

// Просьба разделить задним числом: кнопка в поле ввода, текст — с сервера.
sent = undefined;
const ask = page.getByRole('button', { name: 'Разделить задачи по чатам' });
check(await waitEnabled(ask), 'у вкладки проекта кнопка разделения есть');
await ask.click();
await page.waitForTimeout(1500);
check(
  sent?.prompt === 'Разбей задачи блоком claude-control:split.',
  'просьба ушла текстом сервера',
);
check(splitBody === undefined, 'просьба ничего не заводит сама по себе');

// Согласие проверяем на свежей ленте: после наших реплик предложение перестало
// быть последним, а решают только по последнему.
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForSelector('nav');
await page.waitForTimeout(1800);
check(await waitEnabled(apply), 'вкладка вернулась к тому же разговору с предложением');

// Вкладок до разделения: одна домашняя плюс открытый проект.
const tabsBefore = await page.getByRole('tab').count();

// «Только завести чаты»: заготовки без стартовавших агентов.
const createOnly = page.getByRole('switch', { name: 'Только завести чаты, не запускать агентов' });
await waitEnabled(createOnly);
await createOnly.click();
await page.waitForTimeout(200);
await waitEnabled(apply);
await apply.click();
await page.waitForTimeout(1500);

check(Boolean(splitBody), 'согласие ушло на сервер');
check(splitBody?.startRuns === false, '«только завести чаты» доехало до сервера');
check(splitBody?.projectPath === PROJECT.path, 'каталог проекта передан');
check(splitBody?.proposal?.groups?.length === 2, 'предложение ушло целиком');
check(
  (await page.getByText('Заведено чатов: 2').count()) > 0,
  'о заведённых чатах сказано человеку',
);

// Разделение на две группы раньше открывало две новые вкладки проекта, и один
// проект превращался в три. Дети живут деревом в этой же вкладке.
const tabsAfter = await page.getByRole('tab').count();
check(tabsAfter === tabsBefore, `вкладок не прибавилось: было ${tabsBefore}, стало ${tabsAfter}`);

check(errors.length === 0, errors.length === 0 ? 'ошибок консоли нет' : errors.join(' | '));

await browser.close();
console.log(bad === 0 ? 'Разделение задач работает' : `Проблем: ${bad}`);
process.exit(bad === 0 ? 0 : 1);
