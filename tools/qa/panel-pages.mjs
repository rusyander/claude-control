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
          'claude-control:workspace',
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
  { path: '/compare', name: 'Сравнение' },
  { path: '/dlp', name: 'Защита данных' },
  { path: '/search', name: 'Поиск' },
  { path: '/history', name: 'История изменений' },
  { path: '/settings', name: 'Настройки' },
  { path: '/help', name: 'Справка' },
];

/**
 * Открывает раздел и доводит его до проверяемого вида: ждёт навигацию, для
 * разделов с `prepare` перезагружает страницу и ждёт маркер `ready`, потом
 * даёт данным раздела догрузиться. Один путь для axe и для клавиатуры, чтобы
 * оба обхода смотрели на одинаковую страницу.
 */
export async function openPanelPage(page, base, { path, prepare, ready }) {
  await page.goto(`${base}${path}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('nav', { timeout: 15000 });
  if (prepare) {
    await prepare(page);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('nav', { timeout: 15000 });
    await page.waitForSelector(ready, { timeout: 15000 });
  }
  await page.waitForTimeout(1200);
}

/** Имя файла отчёта из пути: `/` → `root`, `/claude-md` → `claude-md`. */
export const pageSlug = (path) =>
  path === '/' ? 'root' : path.replace(/^\//, '').replace(/[^a-z0-9-]+/gi, '-');

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
