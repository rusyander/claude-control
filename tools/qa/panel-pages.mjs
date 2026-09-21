/**
 * Все разделы панели — один список для обходов доступности и клавиатуры.
 * Маршруты повторяют `apps/web/src/app/router/router.tsx`: добавился раздел —
 * добавь строку сюда, иначе аудит его не увидит.
 *
 * `prepare`/`ready` — для разделов, которые сами себя не показывают целиком:
 * страница доводится до насыщенного вида и перезагружается, а маркер `ready`
 * подтверждает, что шаг сработал (молча не сработавший оставил бы «чисто»
 * пустым словом).
 */
export const PANEL_PAGES = [
  { path: '/', name: 'Обзор' },
  { path: '/analytics', name: 'Аналитика' },
  {
    path: '/chat',
    name: 'Чат',
    // Лента вкладок проектов появляется только когда проект открыт, а это самый
    // насыщенный ролями кусок страницы: tablist, вкладки, точки статуса.
    // Состояние кладём прямо в хранилище ленты: так проверка не зависит ни от
    // какой истории и не открывает настоящий проект.
    prepare: async (page) => {
      await page.evaluate(() => {
        localStorage.setItem(
          'agentdeck:workspace',
          JSON.stringify({
            projectTabs: [{ id: 'c:/a11y', path: 'C:/a11y', name: 'Проверка ленты' }],
            activeTabId: 'home',
            views: {},
          }),
        );
      });
    },
    ready: '[role="tablist"][aria-label="Рабочие пространства"]',
  },
  {
    path: '/chat',
    name: 'Чат — git проекта',
    slug: 'chat-git',
    // Окно git проекта живёт только при открытом проекте и закрытым не попадает
    // ни в один обход, а внутри него самая плотная часть — список параллельных
    // копий: карточка полноты копии, список недостающего, «Добрать», отчёт
    // зеркала. Путь проекта берётся из `QA_GIT_PROJECT`, иначе — сам репозиторий
    // панели: в нём есть git, но копий может не быть, и тогда обход видит список
    // веток без карточек. Проверять карточку — стенд с копиями и эта переменная.
    prepare: async (page) => {
      const project = process.env.QA_GIT_PROJECT || process.cwd();
      await page.evaluate((path) => {
        const id = path.toLowerCase().replace(/\\/g, '/');
        localStorage.setItem(
          'agentdeck:workspace',
          JSON.stringify({
            projectTabs: [{ id, path, name: 'git' }],
            activeTabId: id,
            views: {},
          }),
        );
      }, project);
    },
    ready: '[role="tablist"][aria-label="Рабочие пространства"]',
    interact: async (page) => {
      // Кнопка ветки узнаётся по своей подсказке: её доступное имя — это имя
      // текущей ветки, которое у каждого проекта своё.
      const open = page.locator('button[title^="Git проекта"]').first();
      if ((await open.count()) === 0) return;
      await open.click();
      await page.waitForSelector('[role="dialog"][aria-label="Git проекта"]', { timeout: 10000 });
      await page.waitForTimeout(1200);
    },
  },
  { path: '/rules', name: 'Правила' },
  { path: '/claude-md', name: 'CLAUDE.md' },
  { path: '/skills', name: 'Скиллы' },
  { path: '/commands', name: 'Команды' },
  { path: '/scripts', name: 'Скрипты' },
  { path: '/hooks', name: 'Хуки' },
  { path: '/plugins', name: 'Плагины' },
  { path: '/mcp', name: 'MCP' },
  { path: '/permissions', name: 'Права' },
  { path: '/env', name: 'Переменные' },
  { path: '/groups', name: 'Группы' },
  { path: '/projects', name: 'Проекты' },
  { path: '/tests', name: 'Тестирование' },
  // Вкладки тестов, как и вкладки настроек, рисуют по одной панели за раз:
  // отчёт и матрица покрытия — две самые плотные таблицы раздела, и обход,
  // открывающий только библиотеку, не видит ни одной из них.
  { path: '/tests?tab=report', name: 'Тестирование — отчёт' },
  { path: '/tests?tab=coverage', name: 'Тестирование — покрытие' },
  { path: '/compare', name: 'Сравнение' },
  { path: '/portability', name: 'Паспорт среды' },
  { path: '/dlp', name: 'Защита данных' },
  {
    path: '/platform',
    name: 'Контур',
    // Значок компромисса закрыт по умолчанию, а проверять надо именно открытую
    // подсказку: в ней и текст, и связь aria-describedby, и разворот у края.
    // Открываем фокусом, как это делает человек с клавиатуры.
    interact: async (page) => {
      const trigger = page.locator('[data-compromise-mark] button').first();
      if ((await trigger.count()) === 0) return;
      await trigger.focus();
      await page.waitForTimeout(200);
    },
  },
  {
    path: '/platform',
    name: 'Контур — мастер',
    slug: 'platform-wizard',
    // Мастер — самая плотная форма раздела: четыре шага, поля, галки целей и
    // значки компромиссов внутри модального окна. Закрытым его не проверяет ни
    // один обход, а именно в нём человек проводит первые пять минут.
    interact: async (page) => {
      const open = page.getByRole('button', { name: 'Подключить контур' }).first();
      if ((await open.count()) === 0) return;
      await open.click();
      await page.waitForTimeout(300);
    },
  },
  {
    path: '/',
    name: 'Агент панели — окно',
    slug: 'panel-agent-window',
    // Окно агента открывается из боковой панели на любой странице и закрытым
    // не попадает ни в один обход: вкладки, поле ввода и карточки подтверждения
    // живут только внутри открытого окна (немодального, у правого края).
    interact: async (page) => {
      const trigger = page.locator('[data-panel-agent-trigger]').first();
      if ((await trigger.count()) === 0) return;
      await trigger.click();
      await page.waitForTimeout(300);
    },
  },
  { path: '/search', name: 'Поиск' },
  { path: '/history', name: 'История изменений' },
  { path: '/settings', name: 'Настройки' },
  // Вкладки настроек рисуют по одной панели за раз: обход, открывающий только
  // `/settings`, не видит ни одной, кроме первой. «Интеграции» держат пять
  // форм с полями и переключателями — их проверять надо.
  { path: '/settings?tab=integrations', name: 'Настройки — интеграции' },
  // «Промпты» — единственная вкладка настроек с редактором текста: свой список,
  // своё многострочное поле и две кнопки у каждого промпта.
  { path: '/settings?tab=prompts', name: 'Настройки — промпты' },
  { path: '/help', name: 'Справка' },
];

/**
 * Открывает раздел и доводит его до проверяемого вида: ждёт навигацию, для
 * разделов с `prepare` перезагружает страницу и ждёт маркер `ready`, потом
 * даёт данным раздела догрузиться. Один путь для axe и для клавиатуры, чтобы
 * оба обхода смотрели на одинаковую страницу.
 */
export async function openPanelPage(page, base, { path, prepare, ready, interact }) {
  await page.goto(`${base}${path}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('nav', { timeout: 15000 });
  if (prepare) {
    await prepare(page);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('nav', { timeout: 15000 });
    await page.waitForSelector(ready, { timeout: 15000 });
  }
  // Навигация рисуется сразу, а сам раздел — ленивым куском и после ответа API.
  // Одной паузы под нагрузкой стенда не хватало: обход клавиатуры 14.09.2026
  // назвал «содержимое недосягаемо» раздел, который просто ещё не приехал.
  // Раздел, где фокусироваться и правда не на чем, ждёт потолок и идёт дальше —
  // его назовут сами проверки.
  await page
    .waitForFunction(
      () =>
        Boolean(
          document
            .querySelector('main')
            ?.querySelector('button, a[href], input, select, textarea, [tabindex]'),
        ),
      null,
      { timeout: 10000 },
    )
    .catch(() => undefined);
  await page.waitForTimeout(1200);
  // Шаг после загрузки, а не вместо неё: `prepare` перезагружает страницу и
  // всё открытое им теряется, поэтому раскрытые состояния (подсказка значка,
  // раскрытая карточка) доводятся здесь.
  if (interact) await interact(page);
}

/**
 * Имя файла отчёта из пути: `/` → `root`, `/claude-md` → `claude-md`. Два
 * состояния одного раздела (закрытый и открытый мастер контура) живут по одному
 * пути — второму даётся собственный `slug`, иначе его отчёт затирал бы первый.
 */
export const pageSlug = (path, slug) => {
  if (slug) return slug;
  return path === '/' ? 'root' : path.replace(/^\//, '').replace(/[^a-z0-9-]+/gi, '-');
};

/**
 * Кнопка, открывающая модалку создания, — по тексту, без знания о разделе:
 * так насыщенное состояние проверяется у любого раздела, где такая кнопка есть,
 * и не проверяется молча там, где её нет. Отключённая кнопка (раздел без
 * данных, провайдер без поддержки) — не кандидат: жать её бессмысленно.
 */
export const CREATE_BUTTON = /создать|добавить|нов(ый|ая|ое|ую)/i;

/** Первая видимая и включённая кнопка создания в содержимом раздела, либо null. */
export async function findCreateButton(page) {
  const buttons = page.locator('main').getByRole('button', { name: CREATE_BUTTON });
  const count = await buttons.count();
  for (let i = 0; i < count; i += 1) {
    const button = buttons.nth(i);
    if ((await button.isVisible()) && (await button.isEnabled())) return button;
  }
  return null;
}
