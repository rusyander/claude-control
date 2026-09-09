/**
 * Прогон видимой части уровней разделения (Т1): разбор → план → работа.
 *
 * Конвейер живёт на сервере и покрыт тестами (`split-conveyor.test.ts`,
 * `split-plan.test.ts`); здесь проверяется то, чего тестами не взять, — видит
 * ли человек, ЧТО панель решила за него, и может ли он ответить на вопрос
 * разбора, не заходя в чат группы, которого ещё нет:
 *
 * 1. Сводка у родителя показывает ВСЕ группы, включая те, у которых чата ещё
 *    нет: чего они ждут (разбора, предшественников, ответа), в порядке разбора,
 *    и итог разбора в шапке — с тем, что панель в нём поправила.
 * 2. Ответ на вопрос разбора уходит РОДИТЕЛЮ с номером группы, а не сообщением
 *    в чей-то чат; после ответа группа в сводке становится обычной строкой.
 * 3. В ленте разбора вместо JSON — карточка разбора; в ленте плана — карточка
 *    плана, и вложенный блок команд план не обрывает. Строка-заметка сервера
 *    («разбор применён…») видна в ленте того чата.
 * 4. В списке чатов звенья подписаны «разбор» и «план».
 *
 * Данные подменяются целиком: ни копий, ни прогонов прогон не создаёт.
 *
 * Запуск: `node tools/qa/check-split-levels.mjs` при поднятом `pnpm dev`;
 * `SHOTS=<папка>` — снимки из того же прогона.
 */
import { chromium } from 'playwright';
import { bypassOnboarding } from './bypass-onboarding.mjs';

const BASE = process.env.APP_URL ?? 'http://localhost:8888';
const PROJECT = { name: 'QA уровни', path: 'C:/qa-levels-project' };
const CEILING = { chatModel: 'claude-opus-5', chatEffort: 'high' };

const PARENT = 'qa-levels-parent';
const TRIAGE = 'qa-levels-triage';
const PLAN_A = 'qa-levels-a-plan';
const PLAN_C = 'qa-levels-c-plan';
const HOLD_QUESTION = 'Какие браузеры считать целевыми?';

const GROUPS = [
  { index: 0, title: 'Форма входа', branch: 'feature/login' },
  { index: 1, title: 'Шапка', branch: 'feature/header' },
  { index: 2, title: 'Тесты', branch: 'feature/tests' },
];

/** Блок разбора — номера групп с единицы, как модель и отвечает. */
const TRIAGE_BLOCK = [
  '```agentdeck:split-plan',
  JSON.stringify({
    groups: [
      { index: 1, owns: ['src/login/**'], tasks: ['починить валидацию'] },
      {
        index: 2,
        owns: ['src/header.tsx', 'src/api.ts'],
        after: [1],
        notes: 'api.ts у тебя — Форма входа его не трогает',
      },
      { index: 3, hold: HOLD_QUESTION },
    ],
    conflicts: [{ paths: ['src/api.ts'], resolvedBy: 2, why: 'шапка зовёт его первой' }],
    order: [1, 2, 3],
  }),
  '```',
].join('\n');

/** План с ВЛОЖЕННЫМ блоком команд: закрывающей считается последняя кавычка. */
const PLAN_BLOCK = [
  '```agentdeck:plan',
  '## Шаги',
  '1. Прогнать проверку:',
  '```',
  'pnpm test',
  '```',
  '2. Поправить валидацию в `LoginForm.tsx`.',
  '```',
].join('\n');

const chat = (id, extra) => ({
  id,
  title: extra.title,
  project: PROJECT.name,
  projectPath: extra.projectPath ?? PROJECT.path,
  isSandbox: false,
  messageCount: 1,
  createdAt: extra.createdAt ?? '2026-09-09T10:00:00.000Z',
  updatedAt: '2026-09-09T10:05:00.000Z',
  preview: '',
  ...(extra.parentId ? { parentId: extra.parentId } : {}),
  ...(extra.stage ? { stage: extra.stage } : {}),
  ...(extra.groupTitle ? { groupTitle: extra.groupTitle } : {}),
  ...(extra.branch ? { branch: extra.branch } : {}),
});

const planChat = (id, group, createdAt) =>
  chat(id, {
    title: `План работы для группы «${group.title}» в ветке ${group.branch}.`,
    parentId: PARENT,
    stage: 'plan',
    groupTitle: group.title,
    branch: group.branch,
    projectPath: `${PROJECT.path}-worktrees/${group.branch.replace(/\//g, '-')}`,
    createdAt,
  });

const chats = [
  chat(PARENT, { title: 'Разбор задач' }),
  chat(TRIAGE, {
    title: 'Разбор разделения',
    parentId: PARENT,
    stage: 'triage',
    groupTitle: 'Разбор разделения',
    createdAt: '2026-09-09T10:01:00.000Z',
  }),
  planChat(PLAN_A, GROUPS[0], '2026-09-09T10:03:00.000Z'),
];

/** Вид конвейера: одна группа стартовала, вторая ждёт первую, третья ждёт ответа. */
const split = {
  parentChatId: PARENT,
  triageChatId: TRIAGE,
  triage: {
    at: '2026-09-09T10:02:00.000Z',
    received: true,
    repairs: ['задача «убрать дубль запроса» пропала из разбора — возвращена в группу «Шапка»'],
    conflicts: [{ paths: ['src/api.ts'], resolvedBy: 1, why: 'шапка зовёт его первой' }],
  },
  order: [0, 1, 2],
  groups: [
    { ...GROUPS[0], after: [], status: 'started', chatId: PLAN_A },
    { ...GROUPS[1], after: [0], status: 'waiting' },
    { ...GROUPS[2], after: [], hold: HOLD_QUESTION, status: 'held' },
  ],
};

const messages = (text) => ({
  messages: [
    {
      id: 'm-1',
      role: 'assistant',
      blocks: [{ type: 'text', text }],
      timestamp: '2026-09-09T10:02:00.000Z',
    },
  ],
  total: 1,
  hasMore: false,
});

const frame = (event, seq) => `data: ${JSON.stringify({ ...event, seq })}\n\n`;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
await bypassOnboarding(page, CEILING);

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
        lastActivity: '2026-09-09T10:00:00.000Z',
        chats: [],
      },
    ],
  }),
);
await page.route('**/api/chats', (route) => route.fulfill({ json: chats }));
await page.route('**/api/chat/*/tree', (route) =>
  route.fulfill({
    json: {
      root: PARENT,
      running: 1,
      split,
      nodes: chats
        .filter((item) => item.parentId)
        .map((item) => ({
          chatId: item.id,
          aliases: [],
          parentChatId: PARENT,
          title: item.title,
          running: item.id === TRIAGE,
        })),
    },
  }),
);
await page.route(`**/api/chats/${PARENT}/messages*`, (route) =>
  route.fulfill({ json: messages('Разделил задачи на три группы.') }),
);
await page.route(`**/api/chats/${TRIAGE}/messages*`, (route) =>
  route.fulfill({ json: messages(`Пересекались в api.ts.\n\n${TRIAGE_BLOCK}`) }),
);
await page.route(`**/api/chats/${PLAN_A}/messages*`, (route) =>
  route.fulfill({ json: messages(`Посмотрел код формы.\n\n${PLAN_BLOCK}`) }),
);
await page.route(`**/api/chats/${PLAN_C}/messages*`, (route) =>
  route.fulfill({ json: { messages: [], total: 0, hasMore: false } }),
);
await page.route('**/api/chat/*/progress*', (route) =>
  route.fulfill({ json: { steps: [], isComplete: false } }),
);
await page.route('**/api/chat/*/artifacts*', (route) => route.fulfill({ json: [] }));

// Разбор идёт на сервере: заметка о его итоге приходит потоком и остаётся в
// ленте после конца хода — это итог, а не тост.
await page.route('**/api/chat/active', (route) =>
  route.fulfill({ json: [{ chatId: TRIAGE, seq: 0 }] }),
);
let triageStreamHits = 0;
await page.route(`**/api/chat/${TRIAGE}/stream*`, (route) => {
  triageStreamHits += 1;
  if (triageStreamHits > 1) return;
  return route.fulfill({
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
    body:
      frame(
        {
          kind: 'notice',
          code: 'triageApplied',
          text: 'Разбор применён: стартуют сразу: 1, ждут предшественников: 1, ждут ответа человека: 1.',
        },
        1,
      ) + frame({ kind: 'done' }, 2),
  });
});

// Ответ на вопрос разбора: адресован родителю, несёт номер группы. После него
// заглушка ведёт себя как сервер — группа стартовала, у неё появился чат плана.
const holdCalls = [];
await page.route('**/api/chat/split/*/hold', (route) => {
  const url = new URL(route.request().url());
  holdCalls.push({ parent: url.pathname.split('/').at(-2), ...route.request().postDataJSON() });
  split.groups[2] = {
    ...split.groups[2],
    holdAnswer: 'Chrome и Firefox',
    status: 'started',
    chatId: PLAN_C,
  };
  chats.push(planChat(PLAN_C, GROUPS[2], '2026-09-09T10:08:00.000Z'));
  return route.fulfill({
    json: {
      chats: [
        {
          index: 2,
          title: 'Тесты',
          branch: 'feature/tests',
          chatId: PLAN_C,
          path: `${PROJECT.path}-worktrees/feature-tests`,
          isWorktree: true,
          started: true,
          prompt: '',
          stage: 'plan',
        },
      ],
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
const shot = async (name) => {
  if (!process.env.SHOTS) return;
  await page.screenshot({ path: `${process.env.SHOTS}/${name}.png`, fullPage: false });
};

await page.getByRole('tab', { name: 'Проекты' }).click();
await page.waitForTimeout(800);
await page
  .getByRole('button', { name: new RegExp(PROJECT.name) })
  .first()
  .click();
await page.waitForTimeout(1500);

// 4. Подписи звеньев в списке.
const stageChips = page.locator('[class*="_stage_"]');
check(
  (await stageChips.filter({ hasText: /^разбор$/ }).count()) === 1,
  'звено разбора подписано в списке',
);
check(
  (await stageChips.filter({ hasText: /^план$/ }).count()) === 1,
  'звено плана подписано в списке',
);

await page
  .getByRole('button', { name: /Разбор задач/ })
  .first()
  .click();
await page.waitForTimeout(2000);

// 1. Сводка: все группы, в порядке разбора, с тем, чего ждут.
const hub = page.locator('[data-child-hub]');
check((await hub.count()) === 1, 'сводка групп у родителя показана');
const rows = hub.locator('[data-hub-row]');
check(
  (await rows.count()) === 4,
  `строк в сводке четыре — разбор и три группы: ${await rows.count()}`,
);
const rowTexts = await rows.allInnerTexts();
const titlesInOrder = rowTexts.map((text) => text.split('\n')[0]);
check(
  JSON.stringify(titlesInOrder) ===
    JSON.stringify(['Разбор разделения', 'Форма входа', 'Шапка', 'Тесты']),
  `порядок строк — разбор, затем группы по порядку разбора: ${JSON.stringify(titlesInOrder)}`,
);
check(
  rowTexts[0]?.split('\n')[1]?.startsWith('разбор') === true,
  `строка разбора подписана звеном: ${rowTexts[0]}`,
);
check(
  rowTexts[1]?.includes('feature/login · план'),
  `стартовавшая группа стоит на плане: ${rowTexts[1]}`,
);
check(
  rowTexts[2]?.includes('ждёт: Форма входа'),
  `ждущая группа называет, кого ждёт: ${rowTexts[2]}`,
);
check(rowTexts[3]?.includes('ждёт вашего ответа'), `стоящая группа ждёт ответа: ${rowTexts[3]}`);
check(
  (await hub.locator('[data-hub-row="waiting"]').count()) === 1 &&
    (await hub.locator('[data-hub-row="held"]').count()) === 1,
  'строки без чата помечены тем, чего ждут',
);
const triageChip = hub.locator('[data-hub-triage="applied"]');
check((await triageChip.count()) === 1, 'итог разбора в шапке: применён');
check(
  (await triageChip.innerText()).includes('поправлено панелью: 1'),
  'что панель поправила в разборе — посчитано в шапке',
);
check(
  (await triageChip.getAttribute('title'))?.includes('пропала из разбора') === true,
  'сами поправки — по наведению на фишку',
);
await shot('01_пульт-уровней_AFTER');

// 2. Ответ на вопрос разбора — из сводки, родителю, с номером группы.
const form = hub.locator('[data-hold-form]');
check((await form.count()) === 1, 'форма ответа есть ровно у стоящей группы');
check((await form.innerText()).includes(HOLD_QUESTION), 'вопрос разбора виден целиком');
const send = form.getByRole('button', { name: 'Ответить' });
check(!(await send.isEnabled()), 'пустой ответ отправить нельзя');
await form.locator('textarea').fill('Chrome и Firefox');
await send.click();
await page.waitForTimeout(1500);
check(
  JSON.stringify(holdCalls) ===
    JSON.stringify([{ parent: PARENT, index: 2, answer: 'Chrome и Firefox' }]),
  `ответ ушёл родителю одним запросом с номером группы: ${JSON.stringify(holdCalls)}`,
);
check(
  (await page.getByText(/Ответ принят — «Тесты» стартует/).count()) === 1,
  'тост называет группу, которая стартовала по ответу',
);
check((await hub.locator('[data-hold-form]').count()) === 0, 'после ответа форма убрана');
const answered = await hub.locator('[data-hub-row]').nth(3).innerText();
check(answered.includes('feature/tests · план'), `группа после ответа стоит на плане: ${answered}`);
await shot('02_ответ-на-вопрос-разбора_AFTER');

// 3а. Лента разбора: карточка вместо JSON и заметка сервера.
await hub.locator('[data-hub-row="chat"]').first().click();
await page.waitForTimeout(1500);
const triageBody = await page.locator('body').innerText();
check(!triageBody.includes('agentdeck:split-plan'), 'служебный блок разбора в ленту не попал');
check(!triageBody.includes('"owns"'), 'сырой JSON разбора не показан');
const triageCard = page.locator('[data-triage-card]');
check((await triageCard.count()) === 1, 'карточка разбора показана');
const triageText = await triageCard.innerText();
check(triageText.includes('3 группы'), `группы посчитаны: ${triageText.split('\n')[0]}`);
check(
  triageText.includes('правит: src/header.tsx, src/api.ts') &&
    triageText.includes('после: группа 1'),
  'границы и ожидания группы видны',
);
check(triageText.includes(`Вопрос человеку: ${HOLD_QUESTION}`), 'вопрос человеку виден в карточке');
check(
  triageText.includes('src/api.ts → группа 2 — шапка зовёт его первой'),
  'пересечение и кому отдано — видны',
);
check(triageText.includes('Порядок: группа 1 → группа 2 → группа 3'), 'порядок старта виден');
check(triageBody.includes('Пересекались в api.ts.'), 'слова агента вокруг блока остались');
const notice = page.locator('[data-chat-notice]');
check(
  (await notice.count()) === 1 && (await notice.innerText()).includes('Разбор применён'),
  'заметка сервера об итоге разбора видна в ленте',
);
await shot('03_карточка-разбора_AFTER');

// 3б. Лента плана: карточка, вложенный блок команд план не оборвал.
await page
  .getByRole('button', { name: /План работы для группы «Форма входа»/ })
  .first()
  .click();
await page.waitForTimeout(1500);
const planBody = await page.locator('body').innerText();
check(!planBody.includes('agentdeck:plan'), 'служебный блок плана в ленту не попал');
const planCard = page.locator('[data-plan-card]');
check((await planCard.count()) === 1, 'карточка плана показана');
const planText = await planCard.innerText();
check(
  planText.includes('pnpm test') && planText.includes('Поправить валидацию'),
  'план показан целиком, вложенный блок команд его не оборвал',
);
check(planBody.includes('Посмотрел код формы.'), 'слова агента вокруг плана остались');
await shot('04_карточка-плана_AFTER');

check(errors.length === 0, errors.length === 0 ? 'ошибок консоли нет' : errors.join(' | '));

await browser.close();
console.log(bad === 0 ? 'Уровни разделения видны человеку' : `Проблем: ${bad}`);
process.exit(bad === 0 ? 0 : 1);
