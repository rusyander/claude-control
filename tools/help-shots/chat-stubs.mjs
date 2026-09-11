/**
 * Общие заглушки для съёмки кадров раздела «Чат».
 *
 * Правило то же, что у прогонов `tools/qa/check-*.mjs`: подменяется ОТВЕТ
 * сервера, а не разметка. Экраны, состояния и подписи в кадре — настоящие,
 * ровно те, что человек увидит у себя; выдуманы только данные, за которыми
 * иначе пришлось бы держать установленный CLI, живую модель и ветки на диске.
 *
 * Каталоги и имена файлов подобраны без доменов первого уровня: опись кадра
 * проходит через `tools/qa/check-help-shots.mjs`, и `что-то.dev` в тексте он
 * считает чужим хостом — справедливо, потому что отличить его от настоящего
 * контура заказчика по тексту нельзя.
 */

/** Проект, в котором идёт весь путеводитель. Каталога на диске нет. */
export const PROJECT = { name: 'Панель заказов', path: 'C:/work/orders-panel' };

/** Потолок разговора: от него считается и подбор модели, и цена разделения. */
export const CEILING = { chatModel: 'claude-opus-5', chatEffort: 'high' };

/** Каталог моделей: список в шапке чата и в карточке разделения — из него. */
export const MODELS = {
  provider: 'claude',
  vendors: ['anthropic'],
  source: 'models.dev',
  requestedSource: 'models.dev',
  models: [
    {
      id: 'claude-opus-5',
      name: 'Claude Opus 5',
      family: 'claude-opus',
      vendor: 'anthropic',
      releaseDate: '2026-08-01',
      reasoning: true,
    },
    {
      id: 'claude-sonnet-4-5',
      name: 'Claude Sonnet 4.5',
      family: 'claude-sonnet',
      vendor: 'anthropic',
      releaseDate: '2026-05-01',
      reasoning: true,
    },
    {
      id: 'claude-haiku-4-5',
      name: 'Claude Haiku 4.5',
      family: 'claude-haiku',
      vendor: 'anthropic',
      releaseDate: '2026-04-01',
      reasoning: false,
    },
  ],
};

/** Состояние git проекта: ветка, счётчики и список изменённых файлов. */
export const GIT = {
  isRepo: true,
  branch: 'feature/orders-export',
  detached: false,
  unborn: false,
  branches: ['main', 'feature/orders-export', 'feature/login'],
  dirtyCount: 4,
  changedFiles: [
    { path: 'src/pages/Orders/OrdersPage.tsx', status: 'modified', staged: false },
    { path: 'src/pages/Orders/export.ts', status: 'added', staged: false },
    { path: 'src/shared/api/client.ts', status: 'modified', staged: false },
    { path: 'notes.txt', status: 'untracked', staged: false },
  ],
  remote: 'origin',
  remoteBranches: ['main', 'feature/orders-export'],
  insertions: 128,
  deletions: 31,
  ahead: 2,
  behind: 0,
};

/** Кадр SSE ровно в том виде, в каком его отдаёт сервер панели. */
export const frame = (event, seq) => `data: ${JSON.stringify({ ...event, seq })}\n\n`;

/** Ответ потоком: тело собирается из кадров, заголовок обязателен. */
export const sse = (body) => ({
  status: 200,
  headers: { 'content-type': 'text/event-stream' },
  body,
});

/**
 * Мастер онбординга и потолок разговора одним перехватом настроек.
 *
 * Двумя маршрутами нельзя: Playwright отдаёт запрос последнему подходящему
 * обработчику, и вторая подмена настроек отменила бы обход мастера.
 */
export async function settings(page, patch = {}) {
  await page.route('**/api/settings', async (route) => {
    try {
      if (route.request().method() !== 'GET') return await route.continue();
      const response = await route.fetch();
      const body = await response.json();
      return await route.fulfill({
        response,
        json: { ...body, ...CEILING, ...patch, onboardingDone: true },
      });
    } catch {
      /* контекст закрыт — отвечать уже некому */
    }
  });
}

/**
 * Каркас вкладки проекта: список проектов, git, каталог моделей и всё, что
 * страница спрашивает про каждый разговор. Дальше сценарий доопределяет своё.
 */
export async function projectShell(page, { git = GIT, worktrees } = {}) {
  await page.route('**/api/models*', (route) => route.fulfill({ json: MODELS }));
  await page.route('**/api/project-git/worktrees*', (route) =>
    route.fulfill({
      json: worktrees ?? {
        isRepo: true,
        worktrees: [{ path: PROJECT.path, branch: git.branch, isMain: true, ...FLAGS }],
      },
    }),
  );
  await page.route('**/api/project-git/mirror-settings*', (route) =>
    route.fulfill({ json: { include: [], exclude: [] } }),
  );
  await page.route('**/api/project-git*', (route) => route.fulfill({ json: git }));
  await page.route('**/api/chats/projects*', (route) =>
    route.fulfill({
      json: [
        {
          path: PROJECT.path,
          name: PROJECT.name,
          exists: true,
          lastActivity: '2026-09-10T12:00:00.000Z',
          chats: [],
        },
      ],
    }),
  );
  await page.route('**/api/chat/*/progress*', (route) =>
    route.fulfill({ json: { steps: [], isComplete: false } }),
  );
  await page.route('**/api/chat/*/artifacts*', (route) => route.fulfill({ json: [] }));
  await page.route('**/api/chat/cascade*', (route) =>
    route.fulfill({ json: { enabled: true, project: PROJECT.path } }),
  );
  await page.route('**/api/chat/handoff/state*', (route) =>
    route.fulfill({ json: { auto: true, depth: 1, maxChain: 8 } }),
  );
}

/** Признаки копии, одинаковые у всех: перечислять их в каждой строке незачем. */
export const FLAGS = { detached: false, locked: false, prunable: false };

/** Запись разговора в списке чатов. */
export const chat = (id, title, extra = {}) => ({
  id,
  title,
  project: PROJECT.name,
  projectPath: PROJECT.path,
  isSandbox: false,
  messageCount: 4,
  createdAt: '2026-09-10T11:00:00.000Z',
  updatedAt: '2026-09-10T12:00:00.000Z',
  preview: title,
  ...extra,
});

/** Открыть вкладку проекта: сегмент «Проекты» → строка проекта. */
export async function openProject(page, web) {
  await page.goto(`${web}/chat`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('nav');
  await page.waitForTimeout(1500);
  await page.getByRole('tab', { name: 'Проекты' }).click();
  await page.waitForTimeout(800);
  await page
    .getByRole('button', { name: new RegExp(PROJECT.name) })
    .first()
    .click();
  await page.waitForTimeout(2000);
}

/**
 * Закрыть открытый пульт.
 *
 * Escape здесь не работает, а подложка пульта перехватывает указатель: пока
 * она висит, любой следующий клик стоит до таймаута. Закрывает её тот же
 * обработчик, что и у человека, — щелчок по подложке; но щёлкать по координате
 * бесполезно, в центре подложки лежит сам пульт, поэтому событие отправляется
 * узлу напрямую.
 */
export async function closeOverlay(page) {
  const backdrop = page.locator('[class*="_backdrop"]').first();
  if (await backdrop.count()) await backdrop.evaluate((node) => node.click());
  else await page.keyboard.press('Escape');
  await page.waitForTimeout(800);
}

/** Открыть разговор по заголовку в списке слева. */
export async function openChat(page, title) {
  await page
    .getByRole('button', { name: new RegExp(title) })
    .first()
    .click();
  await page.waitForTimeout(2000);
}
