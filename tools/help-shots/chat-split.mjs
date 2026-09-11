/**
 * Сценарий `split`: путь, на котором один разговор становится несколькими.
 *
 * Тот же проект и тот же человек, что в `basics`, но вход другой: предложение
 * разделить задачи приходит вместо работы, и дальше всё решается не в одном
 * чате, а в сводке групп у родителя. Поэтому и сценарий отдельный: человек,
 * который никогда не делит задачи, сюда не заходит вовсе.
 */
import {
  PROJECT,
  FLAGS,
  chat,
  frame,
  sse,
  settings,
  projectShell,
  openProject,
  openChat,
} from './chat-stubs.mjs';

const PARENT = 'help-split-parent';
const A_PLAN = 'help-split-a-plan';
const A_WORK = 'help-split-a-work';
const A_REVIEW = 'help-split-a-review';
const B_PLAN = 'help-split-b-plan';
const B_WORK = 'help-split-b-work';

const A = { title: 'Выгрузка заказов', branch: 'feature/orders-export' };
const B = { title: 'Фильтры списка', branch: 'feature/orders-filters' };

/** Предложение агента: ровно тот блок, который он пишет в ответе. */
const PROPOSAL = {
  shared: 'Общий контекст: панель на React, правки в src/pages/Orders.',
  groups: [
    {
      title: A.title,
      branch: A.branch,
      tasks: ['собрать CSV из тех же данных, что и таблица', 'кнопку выгрузки в шапку страницы'],
      kind: 'implementation',
    },
    {
      title: B.title,
      branch: B.branch,
      tasks: ['фильтр по статусу', 'фильтр по дате', 'сохранять выбор в адресе страницы'],
      kind: 'implementation',
    },
    {
      title: 'Отчёт по возвратам',
      branch: 'feature/returns-report',
      tasks: ['посчитать возвраты за период', 'вынести в отдельный маршрут'],
      kind: 'design',
    },
  ],
};

const block = (json) => ['```agentdeck:split', JSON.stringify(json), '```'].join('\n');

const PARENT_MESSAGES = {
  messages: [
    {
      id: 's1',
      role: 'user',
      blocks: [
        {
          type: 'text',
          text: 'Три дела по странице заказов: выгрузка в CSV, фильтры списка и отчёт по возвратам.',
        },
      ],
      timestamp: '2026-09-10T11:00:00.000Z',
    },
    {
      id: 's2',
      role: 'assistant',
      blocks: [
        {
          type: 'text',
          text: `Задачи независимы: общий у них только каталог.\n\n${block(PROPOSAL)}\n\nЖду решения.`,
        },
      ],
      timestamp: '2026-09-10T11:02:00.000Z',
    },
  ],
  total: 2,
  hasMore: false,
};

/** Звено группы в списке чатов: ветка, имя группы и стадия конвейера. */
const link = (id, group, stage, extra = {}) =>
  chat(id, `${group.title} · ${stage}`, {
    parentId: PARENT,
    branch: group.branch,
    groupTitle: group.title,
    stage,
    projectPath: `${PROJECT.path}-worktrees/${group.branch.replace(/\//g, '-')}`,
    ...extra,
  });

const CHILDREN = [
  link(A_PLAN, A, 'plan', {
    createdAt: '2026-09-10T11:03:00.000Z',
    updatedAt: '2026-09-10T11:05:00.000Z',
    model: 'claude-opus-5',
  }),
  link(A_WORK, A, 'work', {
    createdAt: '2026-09-10T11:05:00.000Z',
    updatedAt: '2026-09-10T11:24:00.000Z',
    model: 'claude-sonnet-4-5',
    firstEditAt: '2026-09-10T11:05:12.000Z',
  }),
  link(A_REVIEW, A, 'review', {
    createdAt: '2026-09-10T11:24:00.000Z',
    updatedAt: '2026-09-10T11:31:00.000Z',
    model: 'claude-opus-5',
  }),
  link(B_PLAN, B, 'plan', {
    createdAt: '2026-09-10T11:03:00.000Z',
    updatedAt: '2026-09-10T11:06:00.000Z',
    model: 'claude-opus-5',
  }),
  link(B_WORK, B, 'work', {
    createdAt: '2026-09-10T11:06:00.000Z',
    updatedAt: '2026-09-10T11:29:00.000Z',
    model: 'claude-sonnet-4-5',
    firstEditAt: '2026-09-10T11:06:09.000Z',
  }),
];

/** Вопрос ребёнка: человек отвечает на него, не заходя в его чат. */
const CHILD_QUESTION = {
  questions: [
    {
      question: 'Куда класть кнопку выгрузки?',
      header: 'Кнопка',
      multiSelect: false,
      options: [
        { label: 'В шапку страницы', description: 'Рядом с фильтром.' },
        { label: 'В меню строки', description: 'По заказу, а не по списку.' },
      ],
    },
  ],
};

const PERMISSION = frame(
  {
    kind: 'permission',
    toolName: 'Bash',
    input: { command: 'git reset --hard origin/main', description: 'Сбросить копию к базе' },
    toolUseId: 'split-perm-1',
  },
  1,
);

const QUESTION = frame(
  { kind: 'tool', name: 'AskUserQuestion', input: CHILD_QUESTION, id: 'split-ask-1' },
  1,
);

/** Пересечения веток: одно нарушение границ и один законный общий файл. */
const OVERLAP = {
  at: '2026-09-10T11:35:00.000Z',
  files: [
    { path: 'src/shared/api/client.ts', groups: [0, 1], outside: [1] },
    { path: 'src/pages/Orders/OrdersPage.tsx', groups: [0, 1], outside: [] },
  ],
  mergeOrder: [0, 1],
  counted: [
    { index: 0, files: 14 },
    { index: 1, files: 9 },
  ],
  unread: [],
};

/** Копии репозитория: основная плюс по одной на группу, со следом установки. */
const WORKTREES = {
  isRepo: true,
  worktrees: [
    { path: PROJECT.path, branch: 'main', head: 'a1b2c3d', isMain: true, ...FLAGS },
    {
      path: `${PROJECT.path}-worktrees/feature-orders-export`,
      branch: A.branch,
      head: 'e4f5a6b',
      isMain: false,
      ...FLAGS,
      bootstrap: {
        command: 'pnpm install --frozen-lockfile --prefer-offline',
        status: 'ok',
        startedAt: '2026-09-10T11:03:00.000Z',
        finishedAt: '2026-09-10T11:03:48.000Z',
        exitCode: 0,
        logTail: 'Packages: +812\nDone in 47.6s',
        reverted: ['pnpm-lock.yaml'],
      },
    },
    {
      path: `${PROJECT.path}-worktrees/feature-orders-filters`,
      branch: B.branch,
      head: 'c7d8e9f',
      isMain: false,
      ...FLAGS,
      bootstrap: {
        command: 'pnpm install --frozen-lockfile --prefer-offline',
        status: 'ok',
        startedAt: '2026-09-10T11:03:00.000Z',
        finishedAt: '2026-09-10T11:03:52.000Z',
        exitCode: 0,
        logTail: 'Packages: +812\nDone in 51.2s',
      },
    },
  ],
};

export async function shootSplit(browser, web, scenario) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

  /** Дети появляются ПОСЛЕ согласия: до него карточка предлагает, а не отчитывается. */
  let withChildren = false;
  let paused = false;
  let overlap;

  try {
    await settings(page);
    await projectShell(page, { worktrees: WORKTREES });

    await page.route('**/api/chats', (route) =>
      route.fulfill({
        json: withChildren
          ? [chat(PARENT, 'Разбор задач'), ...CHILDREN].map((item) =>
              paused ? { ...item, paused: true } : item,
            )
          : [chat(PARENT, 'Разбор задач')],
      }),
    );
    // Порядок обязателен: Playwright отдаёт запрос ПОСЛЕДНЕМУ подходящему
    // обработчику, и общий перехват, поставленный после частного, забрал бы
    // ленту родителя себе — вместе с карточкой разделения.
    await page.route('**/api/chats/*/messages*', (route) =>
      route.fulfill({ json: { messages: [], total: 0, hasMore: false } }),
    );
    await page.route(`**/api/chats/${PARENT}/messages*`, (route) =>
      route.fulfill({ json: PARENT_MESSAGES }),
    );

    await page.route('**/api/chat/active', (route) =>
      route.fulfill({
        json:
          withChildren && !paused
            ? [
                { chatId: A_WORK, seq: 0 },
                { chatId: B_WORK, seq: 0 },
              ]
            : [],
      }),
    );

    await page.route('**/api/chat/*/tree/pause', (route) => {
      paused = true;
      return route.fulfill({ json: { root: PARENT, stopped: 2, chats: 5, alreadyPaused: false } });
    });
    await page.route('**/api/chat/*/tree/resume', (route) => {
      paused = false;
      return route.fulfill({ json: { root: PARENT, wasPaused: true, resumed: 2, flushed: 0 } });
    });
    await page.route('**/api/chat/split/*/overlap', (route) => {
      overlap = OVERLAP;
      return route.fulfill({ json: OVERLAP });
    });
    await page.route('**/api/chat/*/tree', (route) =>
      route.fulfill({
        json: {
          root: PARENT,
          running: paused ? 0 : 2,
          ...(paused ? { paused: { at: '2026-09-10T11:36:00.000Z', chats: 5, pending: 0 } } : {}),
          split: {
            parentChatId: PARENT,
            order: [0, 1],
            triage: {
              at: '2026-09-10T11:02:40.000Z',
              received: true,
              repairs: [],
              conflicts: [],
            },
            ...(overlap ? { overlap } : {}),
            groups: [
              {
                index: 0,
                title: A.title,
                branch: A.branch,
                after: [],
                status: 'started',
                chatId: A_WORK,
              },
              {
                index: 1,
                title: B.title,
                branch: B.branch,
                after: [],
                status: 'started',
                chatId: B_WORK,
              },
            ],
          },
          nodes: CHILDREN.map((item) => ({
            chatId: item.id,
            aliases: [],
            parentChatId: PARENT,
            title: item.title,
            running: !paused && (item.id === A_WORK || item.id === B_WORK),
          })),
        },
      }),
    );

    const once = (id, body) => {
      let hits = 0;
      return page.route(`**/api/chat/${id}/stream*`, (route) => {
        hits += 1;
        if (hits > 1) return;
        return route.fulfill(sse(body));
      });
    };
    await once(A_WORK, QUESTION);
    await once(B_WORK, PERMISSION);

    await page.route('**/api/chat/send', (route) => route.fulfill(sse('')));
    await page.route('**/api/chat/*/permission-decision', (route) =>
      route.fulfill({ json: { ok: true } }),
    );
    await page.route('**/api/chat/split/decline', (route) => route.fulfill({ json: { ok: true } }));

    // ── 01. Предложение разделить задачи ─────────────────────────────────────
    // Карточка трёх групп выше рабочего окна, а лента уезжает вниз: на 900 px
    // в кадр не попадала первая группа — та, по которой и читают состав.
    await page.setViewportSize({ width: 1440, height: 1240 });
    await openProject(page, web);
    await openChat(page, 'Разбор задач');
    await page
      .locator('[data-split-card]')
      .first()
      .evaluate((node) => node.scrollIntoView({ block: 'center' }));
    await page.waitForTimeout(1000);
    // Поле шире обычного: карточка узкая, а в документе кадр растягивается на
    // всю ширину колонки — без запаса вокруг её буквы раздувает вдвое.
    await scenario.shot(page, '01-proposal', { clip: '[data-split-card]', padding: 160 });
    await page.setViewportSize({ width: 1440, height: 900 });

    // Согласие: дальше всё живёт деревом под этим разговором.
    withChildren = true;
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('nav');
    await page.waitForTimeout(3000);

    // ── 02. Что стало с разговором: дерево слева, сводка в ленте ─────────────
    // Кадр целиком и намеренно: единственное место, где видно сразу оба ответа
    // на «куда всё делось» — список звеньев и сводка групп под ним.
    await page.locator('[data-child-hub]').first().scrollIntoViewIfNeeded();
    await page.waitForTimeout(1500);
    await scenario.shot(page, '02-tree');

    // ── 03. Сводка групп у родителя ──────────────────────────────────────────
    await scenario.shot(page, '03-hub', { clip: '[data-child-hub]' });

    // ── 04. Ребёнок спрашивает — отвечают в родителе ─────────────────────────
    // Карточка ребёнка стоит в самом низу ленты и на рабочем окне обрезается
    // полем ввода: окно выше, и карточка выведена на середину.
    await page.setViewportSize({ width: 1440, height: 1240 });
    await page.waitForTimeout(800);
    await page
      .locator('[class*="_childAsk_"]')
      .first()
      .evaluate((node) => node.scrollIntoView({ block: 'center' }));
    await page.waitForTimeout(600);
    await scenario.shot(page, '04-child-ask', { clip: '[class*="_childAsk_"]' });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.waitForTimeout(800);

    // ── 05. Сверка веток после работы ────────────────────────────────────────
    await page
      .getByRole('button', { name: /^(Сверить ветки|Check branches)$/ })
      .first()
      .click();
    await page.waitForTimeout(2000);
    // Поля почти нет: над панелью идёт строка группы, и на обычном поле она
    // попадала в кадр обрезанной наполовину.
    await scenario.shot(page, '05-overlap', { clip: '[data-hub-overlap]', padding: 4 });

    // ── 06. Пауза всего дерева ───────────────────────────────────────────────
    await page
      .getByRole('button', { name: /^(Остановить всё|Stop all)/ })
      .first()
      .click();
    await page.waitForTimeout(2500);
    await scenario.shot(page, '06-paused', { clip: '[data-child-hub]' });

    // ── 07. Параллельные копии репозитория ───────────────────────────────────
    // Кнопка ищется по полосе git над лентой, а не по имени ветки: в дереве
    // разделения то же имя носят звенья в списке слева, и по названию первым
    // находится разговор, а не пульт.
    await page.setViewportSize({ width: 1440, height: 1240 });
    await page.locator('[class*="_wrapStrip"] button').first().click();
    await page.waitForTimeout(1500);
    // Копии — в самом низу пульта, а он прокручивается внутри себя.
    const gitPanel = page.locator('[role="dialog"]').first();
    await gitPanel.evaluate((node) => node.scrollTo(0, node.scrollHeight));
    await page.waitForTimeout(800);
    // Пульт узкий (350 px), и запас вокруг него обязателен: кадр раздаётся на
    // ширину колонки документа, а узкая картинка в ней разбухает до плаката.
    await scenario.shot(page, '07-worktrees', { clip: '[role="dialog"]', padding: 240 });
  } finally {
    await page.close();
  }
}
