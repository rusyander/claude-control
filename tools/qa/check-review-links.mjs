/**
 * Прогон ревью чужих запросов на слияние по ссылке (Т7).
 *
 * Домен покрыт тестами, здесь проверяется то, чего тестами не проверить: видит
 * ли человек решение, которое панель НЕ приняла за него, и уходит ли на сервер
 * ровно то, что он нажал. Опасного тут два действия — запись в чужой MR и push
 * в чужую ветку, — и оба существуют только как клик по карточке.
 *
 * Проверяется:
 * 1. Карточка ревью в хабе родителя: ссылка, замечания, четыре ответа.
 * 2. Клик «Починить в копии» уходит на `review-decision` с ключом группы и без
 *    `all` — соседей он не трогает.
 * 3. «Отписать в MR» без интеграции недоступна и НАЗЫВАЕТ причину: молчащая
 *    кнопка хуже отсутствующей.
 * 4. Ревью без замечаний показано закрытым, без единой кнопки.
 * 5. После правок появляется «Закоммитить и отправить в MR» — отдельным кликом.
 * 6. В чате самой группы карточка ОДНА, своя: решать за соседей, не видя их
 *    работы, человеку не предлагают.
 * 7. Карточка предложения показывает ссылку каждой ревью-группы: заголовки MR
 *    повторяются, а согласие даётся до заведения копий.
 *
 * Данные подменяются целиком: ни прогонов, ни копий, ни запросов к форджу.
 *
 * Запуск: `node tools/qa/check-review-links.mjs` при поднятом `pnpm dev`.
 */
import { chromium } from 'playwright';
import { bypassOnboarding } from './bypass-onboarding.mjs';

const BASE = process.env.APP_URL ?? 'http://localhost:8888';
const PROJECT = { name: 'QA ревью', path: 'C:/qa-review-project' };
const CEILING = { chatModel: 'claude-opus-5', chatEffort: 'high' };

const PARENT = 'qa-review-parent';
const KID1 = 'qa-review-42';
const KID2 = 'qa-review-43';
const KID3 = 'qa-review-44';

const MR1 = 'https://gitlab.com/team/app/-/merge_requests/42';
const MR2 = 'https://gitlab.com/team/app/-/merge_requests/43';
const MR3 = 'https://gitlab.com/team/app/-/merge_requests/44';
const BLOCKED = 'интеграция с форджем не настроена';

const FINDINGS = [
  'src/auth/login.ts:88 — ошибка входа гасится пустым catch',
  'нет теста на просроченный токен',
];

const chat = (id, extra) => ({
  id,
  title: extra.title,
  project: PROJECT.name,
  projectPath: extra.projectPath ?? PROJECT.path,
  isSandbox: false,
  messageCount: 1,
  createdAt: '2026-09-09T10:00:00.000Z',
  updatedAt: '2026-09-09T10:05:00.000Z',
  ...(extra.parentId ? { parentId: extra.parentId } : {}),
  ...(extra.stage ? { stage: extra.stage } : {}),
});

const CHATS = [
  chat(PARENT, { title: 'Ревью трёх MR' }),
  chat(KID1, {
    title: 'MR 42 — вход',
    parentId: PARENT,
    stage: 'review',
    projectPath: `${PROJECT.path}-worktrees/feature-login`,
  }),
  chat(KID2, {
    title: 'MR 43 — шапка',
    parentId: PARENT,
    stage: 'review',
    projectPath: `${PROJECT.path}-worktrees/feature-header`,
  }),
  chat(KID3, {
    title: 'MR 44 — сборка',
    parentId: PARENT,
    stage: 'review',
    projectPath: `${PROJECT.path}-worktrees/feature-build`,
  }),
];

/**
 * Предложение разделения, каким его прислал агент: у ревью-группы заголовок MR
 * повторяем, а решает человек по самому запросу на слияние — значит ссылка
 * обязана быть видна ДО кнопки, прямо в карточке предложения.
 */
const PROPOSAL = {
  groups: [
    { title: 'MR 42 — вход', branch: 'feature/login', tasks: ['ревью'], review: { url: MR1 } },
    { title: 'MR 43 — шапка', branch: 'feature/header', tasks: ['ревью'], review: { url: MR2 } },
  ],
};

const block = (json) => ['```agentdeck:split', JSON.stringify(json), '```'].join('\n');

const MESSAGES = {
  messages: [
    {
      id: 'm-1',
      role: 'assistant',
      blocks: [
        {
          type: 'text',
          text: ['Развёл ссылки по группам.', '', block(PROPOSAL)].join('\n'),
        },
      ],
      timestamp: '2026-09-09T10:01:00.000Z',
    },
  ],
  total: 1,
  hasMore: false,
};

/**
 * Состояние ревью — как на сервере: оно живёт в связях чатов и меняется только
 * решениями человека. Заглушка ведёт его так же, поэтому карточка после клика
 * показывает то, что действительно записано, а не то, что нарисовал клиент.
 */
const reviews = {
  [KID1]: { url: MR1, branch: 'feature/login', findings: FINDINGS },
  [KID2]: {
    url: MR2,
    branch: 'feature/header',
    findings: ['шапка едет на 320px'],
    postBlocked: BLOCKED,
  },
  // Чистое ревью: закрыто само, решать нечего.
  [KID3]: { url: MR3, findings: [], decision: 'none', decidedAt: '2026-09-09T10:04:00.000Z' },
};

const decisions = [];
const pushes = [];

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
await page.route('**/api/chats', (route) => route.fulfill({ json: CHATS }));
await page.route('**/api/chats/*/messages*', (route) => route.fulfill({ json: MESSAGES }));
await page.route('**/api/chat/active', (route) => route.fulfill({ json: [] }));
await page.route('**/api/chat/*/progress*', (route) =>
  route.fulfill({ json: { steps: [], isComplete: false } }),
);
await page.route('**/api/chat/*/artifacts*', (route) => route.fulfill({ json: [] }));

const node = (chatId, title) => ({
  chatId,
  aliases: [],
  parentChatId: PARENT,
  title,
  stage: 'review',
  running: false,
  review: reviews[chatId],
});

await page.route('**/api/chat/*/tree', (route) =>
  route.fulfill({
    json: {
      root: PARENT,
      running: 0,
      nodes: [
        node(KID1, 'MR 42 — вход'),
        node(KID2, 'MR 43 — шапка'),
        node(KID3, 'MR 44 — сборка'),
      ],
    },
  }),
);

/** Решение человека: заглушка меняет состояние ровно так же, как домен. */
await page.route('**/api/chat/split/*/review-decision', (route) => {
  const body = route.request().postDataJSON();
  decisions.push(body);
  const targets = body.all
    ? Object.keys(reviews).filter((id) => reviews[id].findings.length > 0 && !reviews[id].decidedAt)
    : [body.chatId];
  const applied = targets.map((chatId) => {
    const review = reviews[chatId];
    review.decision = body.decision;
    review.decidedAt = '2026-09-09T10:06:00.000Z';
    if (body.decision === 'post' || body.decision === 'both') {
      if (review.postBlocked) review.postError = review.postBlocked;
      else review.postedAt = '2026-09-09T10:06:00.000Z';
    }
    // Правки в заглушке кончаются сразу — иначе кнопку отправки в MR не увидеть.
    if (body.decision === 'fix' || body.decision === 'both') review.pushOffer = true;
    return { chatId, decision: body.decision, ...(review.postedAt ? { posted: true } : {}) };
  });
  return route.fulfill({ json: { applied, skipped: [] } });
});

await page.route('**/api/chat/split/*/review-push', (route) => {
  const body = route.request().postDataJSON();
  pushes.push(body);
  const review = reviews[body.chatId];
  review.pushOffer = false;
  review.pushedAt = '2026-09-09T10:07:00.000Z';
  return route.fulfill({
    json: { applied: [{ chatId: body.chatId, pushChatId: 'new-push' }], skipped: [] },
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

/** Чаты проекта видны только с открытым проектом (`lib/visibleChats.ts`). */
await page.getByRole('tab', { name: 'Проекты' }).click();
await page.waitForTimeout(800);
await page
  .getByRole('button', { name: new RegExp(PROJECT.name) })
  .first()
  .click();
await page.waitForTimeout(1200);

const openChat = async (title) => {
  await page
    .getByRole('button', { name: new RegExp(title) })
    .first()
    .click();
  await page.waitForTimeout(1500);
};

await openChat('Ревью трёх MR');

// Карточка предложения: по ссылке видно, какой именно MR уедет в группу, — а
// не только заголовок, который у соседних MR легко совпадает.
const proposalBody = await page.locator('[data-split-card]').innerText();
check(
  proposalBody.includes(MR1) && proposalBody.includes(MR2),
  'ссылки на MR видны в самом предложении',
);
check(!proposalBody.includes('agentdeck:split'), 'сырой блок разделения в ленту не попал');
await page.locator('[data-split-card]').scrollIntoViewIfNeeded();
await shot('review-proposal');

const card = (mr) => page.locator('[data-review-card]').filter({ hasText: mr });

check((await page.locator('[data-review-card]').count()) === 3, 'в хабе три карточки ревью');
const first = card('merge_requests/42');
const body = await first.innerText();
check(body.includes(MR1), 'ссылка на MR показана целиком — по ней и уходят смотреть');
for (const finding of FINDINGS) {
  check(body.includes(finding), `замечание видно целиком: ${finding.slice(0, 30)}…`);
}
check(
  await first.getByRole('button', { name: 'Починить в копии' }).isVisible(),
  'ответ «починить» есть',
);
check(
  await first.getByRole('button', { name: 'Отписать в MR' }).isVisible(),
  'ответ «отписать» есть',
);
check(
  await first.getByRole('button', { name: 'Ничего не делать' }).isVisible(),
  'отказ тоже ответ',
);

// Соседняя группа ждёт того же — тумблер «ко всем» появляется, но выключен.
const applyAll = first.getByRole('switch');
check(await applyAll.isVisible(), 'при двух ждущих группах предложено решить их разом');
check((await applyAll.getAttribute('data-state')) !== 'checked', 'оптом — только осознанно');

// Ревью без интеграции: кнопка записи в чужой MR недоступна и называет причину.
const second = card('merge_requests/43');
const postButton = second.getByRole('button', { name: 'Отписать в MR' });
check(await postButton.isDisabled(), 'без интеграции в MR не пишут');
check(
  ((await postButton.getAttribute('title')) ?? '').includes(BLOCKED),
  'причина названа на кнопке',
);

// Чистое ревью: закрыто, кнопок нет вовсе.
const third = card('merge_requests/44');
check((await third.innerText()).includes('Замечаний нет'), 'чистое ревью показано закрытым');
check((await third.getByRole('button').count()) === 0, 'у закрытого ревью решать нечего');
await shot('review-cards');

// Решение по одной группе: уходит её ключ и никакого `all`.
await first.getByRole('button', { name: 'Починить в копии' }).click();
await page.waitForTimeout(1500);

check(decisions.length === 1, 'нажатие ушло на сервер один раз');
check(decisions[0]?.chatId === KID1, 'решение адресовано своей группе');
check(decisions[0]?.decision === 'fix', 'ушло именно то, что нажали');
check(!decisions[0]?.all, 'соседей одиночное решение не трогает');

const decided = await card('merge_requests/42').innerText();
check(decided.includes('Решено: чиним в копии'), 'карточка помнит выбор человека');
check(
  (await card('merge_requests/42').getByRole('button', { name: 'Починить в копии' }).count()) === 0,
  'перерешать нечего — выбор из карточки убран',
);
await shot('review-decided');

// Правки кончились — панель ПРЕДЛАГАЕТ отправить их в MR, но не отправляет.
const push = card('merge_requests/42').getByRole('button', { name: /Закоммитить и отправить/ });
check(await push.isVisible(), 'после правок предложено отправить их в MR');
check(pushes.length === 0, 'до нажатия в чужую ветку ничего не ушло');
await push.click();
await page.waitForTimeout(1200);
check(pushes.length === 1 && pushes[0]?.chatId === KID1, 'push уходит только по клику и по адресу');

// Чат самой группы: карточка одна — своя.
await openChat('MR 43 — шапка');
const own = await page.locator('[data-review-card]').count();
check(own === 1, 'в чате группы показана одна карточка');
const ownText = await page.locator('[data-review-card]').innerText();
check(ownText.includes(MR2) && !ownText.includes(MR1), 'и она про СВОЙ запрос на слияние');
await shot('review-in-group');

check(errors.length === 0, errors.length === 0 ? 'ошибок консоли нет' : errors.join(' | '));

await browser.close();
console.log(bad === 0 ? 'Ревью по ссылкам: решение остаётся человеку' : `Проблем: ${bad}`);
process.exit(bad === 0 ? 0 : 1);
