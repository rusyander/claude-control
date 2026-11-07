import { AGENT_HISTORY_CHAT, installAgentHistoryStub } from './agent-history-stub.mjs';
import { CORE_STUB_TASK_ID, installCoreTaskStub } from './core-task-stub.mjs';

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
/**
 * Сетка «Прежние группы» — только чтение (этап 10, F1): подмена отдаёт пару и проектную группу,
 * `page.route` переживает перезагрузку `prepare`.
 */
async function stubGroups(page) {
  const { installLegacyGroupsStub } = await import('./legacy-groups-stub.mjs');
  await installLegacyGroupsStub(page);
}

/**
 * Правила стенда — настоящий CLAUDE.md человека, и в нём может не быть ни одного
 * правила формата панели; тогда полосы вкладок нет и обходить нечего. Список
 * подменяется, файл не трогается; `page.route` перезагрузку переживает.
 */
async function stubRules(page) {
  const rule = (order, title, isEnabled) => ({
    id: `qa-rule-${order}`,
    title,
    body: `Текст правила «${title}».`,
    order,
    isEnabled,
    groupIds: [],
    scope: 'global',
  });
  const rules = [rule(0, 'Отвечать по-русски', true), rule(1, 'Старое правило', false)];
  await page.route('**/api/rules', (route) =>
    route.request().method() === 'GET' ? route.fulfill({ json: rules }) : route.continue(),
  );
}

// Вкладка — явно: страница помнит последнюю у зрителя (`agentdeck.groups.tab`),
// и голый `/groups` открылся бы на «В проектах», где пары нет.
const GROUP_PAGE = {
  path: '/groups?tab=global',
  prepare: stubGroups,
  ready: '[data-agent-anchor="qa-shop-order-global"]',
};

export const PANEL_PAGES = [
  { path: '/', name: 'Обзор' },
  { path: '/analytics', name: 'Аналитика' },
  { path: '/analytics?tab=breakdown', name: 'Аналитика — модели и проекты' },
  { path: '/analytics?tab=activity', name: 'Аналитика — инструменты и часы' },
  { path: '/analytics?tab=sessions', name: 'Аналитика — сессии' },
  { path: '/analytics?tab=live', name: 'Аналитика — агенты и контур' },
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
      // На стенде без входа в CLI чат сам открывает окно «Ассистенту … нужен
      // доступ» — оно приходит вслед за ответом сервера и перехватывает клик.
      // Успел клик раньше окна или нет — гонка, а не свойство раздела, поэтому
      // окно закрывается, где бы оно ни встало: до клика или поверх git.
      const gate = page.getByRole('dialog').filter({ hasText: 'нужен доступ' });
      const dismissGate = async () => {
        if (!(await gate.isVisible().catch(() => false))) return;
        await page.keyboard.press('Escape');
        await gate.waitFor({ state: 'hidden', timeout: 5000 });
      };
      for (let attempt = 0; ; attempt++) {
        await dismissGate();
        try {
          await open.click({ timeout: 5000 });
          break;
        } catch (error) {
          if (attempt >= 3) throw error;
        }
      }
      await page.waitForSelector('[role="dialog"][aria-label="Git проекта"]', { timeout: 10000 });
      await page.waitForTimeout(1200);
      await dismissGate();
    },
  },
  // Окно «Агенты» (этап 11, W3-17) открывается только кнопкой над полем ввода чата и закрытым
  // не попадает ни в один обход. Чат, лента и узлы ядра — подмена (`page.route` переживает
  // перезагрузку `prepare`); в окне дерево, фильтры и подробность первого узла.
  {
    path: `/chat?id=${AGENT_HISTORY_CHAT}`,
    name: 'Чат — окно «Агенты»',
    slug: 'chat-agents',
    prepare: (page) => installAgentHistoryStub(page),
    ready: '[data-agent-history-open]',
    interact: async (page) => {
      // Окно «нужен доступ» на стенде без входа в CLI приходит вслед за ответом сервера и
      // перехватывает клик — закрывается, где бы ни встало.
      const gate = page.getByRole('dialog').filter({ hasText: /нужен доступ|needs access/ });
      const dismissGate = async () => {
        if (!(await gate.isVisible().catch(() => false))) return;
        await page.keyboard.press('Escape');
        await gate.waitFor({ state: 'hidden', timeout: 5000 });
      };
      const modal = page.locator('[data-agent-history-modal]');
      for (let attempt = 0; ; attempt++) {
        await dismissGate();
        try {
          await page.locator('[data-agent-history-open]').click({ timeout: 5000 });
          await modal.waitFor({ timeout: 5000 });
          break;
        } catch (error) {
          if (attempt >= 3) throw error;
        }
      }
      await modal.locator('[data-agent-row][data-agent-kind="subagent"]').first().click();
      await modal.locator('[data-agent-detail]').waitFor({ timeout: 10000 });
      await page.waitForTimeout(600);
      await dismissGate();
    },
  },
  { path: '/rules', name: 'Правила' },
  {
    path: '/rules?tab=enabled',
    name: 'Правила — включены',
    prepare: stubRules,
    ready: '[role="tablist"]',
  },
  {
    path: '/rules?tab=disabled',
    name: 'Правила — выключены',
    prepare: stubRules,
    ready: '[role="tablist"]',
  },
  { path: '/claude-md', name: 'CLAUDE.md' },
  { path: '/skills', name: 'Скиллы' },
  { path: '/commands', name: 'Команды' },
  { path: '/scripts', name: 'Скрипты' },
  { path: '/scripts?tab=used', name: 'Скрипты — используются' },
  { path: '/scripts?tab=unused', name: 'Скрипты — не привязаны' },
  { path: '/scripts?tab=test', name: 'Скрипты — тесты' },
  { path: '/hooks', name: 'Хуки' },
  { path: '/plugins', name: 'Плагины' },
  { path: '/plugins?tab=catalog', name: 'Плагины — каталог' },
  { path: '/plugins?tab=marketplaces', name: 'Плагины — маркетплейсы' },
  { path: '/plugins?tab=scaffold', name: 'Плагины — свой плагин' },
  { path: '/mcp', name: 'MCP' },
  { path: '/permissions', name: 'Права' },
  // «Все правила» — длинный список прав с действиями в строке (перенос, правка,
  // удаление, тумблер у общих): вкладка не открывается адресом, только кнопкой.
  {
    path: '/permissions',
    name: 'Права — все правила',
    slug: 'permissions-all',
    interact: async (page) => {
      await page.locator('main').getByRole('button', { name: 'Все правила' }).click();
      await page.waitForTimeout(400);
    },
  },
  { path: '/env', name: 'Переменные' },
  { path: '/groups', name: 'Группы' },
  {
    ...GROUP_PAGE,
    name: 'Группы — сетка карточек',
    slug: 'groups-grid',
  },
  { path: '/projects', name: 'Проекты' },
  { path: '/tests', name: 'Тестирование' },
  // Библиотека с настоящими кейсами — таблица со значками статуса, важности и
  // действиями строки. Проект — этот репозиторий (`.agent/tests/`), только чтение.
  {
    path: `/tests?project=${encodeURIComponent(process.cwd())}`,
    name: 'Тестирование — библиотека с кейсами',
    slug: 'tests-library',
  },
  // Вкладки тестов, как и вкладки настроек, рисуют по одной панели за раз:
  // отчёт и матрица покрытия — две самые плотные таблицы раздела, и обход,
  // открывающий только библиотеку, не видит ни одной из них.
  { path: '/tests?tab=report', name: 'Тестирование — отчёт' },
  { path: '/tests?tab=coverage', name: 'Тестирование — покрытие' },
  { path: '/compare', name: 'Сравнение' },
  { path: '/compare?tab=env', name: 'Сравнение — переменные' },
  { path: '/compare?tab=permissions', name: 'Сравнение — права' },
  { path: '/compare?tab=instructions', name: 'Сравнение — инструкции' },
  { path: '/portability', name: 'Паспорт среды' },
  { path: '/portability?tab=transfer', name: 'Паспорт среды — перенос' },
  { path: '/portability?tab=subscription', name: 'Паспорт среды — подписка' },
  { path: '/portability?tab=probe', name: 'Паспорт среды — проба цели' },
  { path: '/portability?tab=carry', name: 'Паспорт среды — незакрытая работа' },
  { path: '/dlp', name: 'Защита данных' },
  { path: '/dlp?tab=rules', name: 'Защита данных — правила' },
  { path: '/dlp?tab=check', name: 'Защита данных — проверка' },
  { path: '/dlp?tab=journal', name: 'Защита данных — журнал' },
  { path: '/dlp?tab=gate', name: 'Защита данных — гейт промпта' },
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
  { path: '/local-models', name: 'Локальные модели' },
  { path: '/local-models?tab=models', name: 'Локальные модели — модели' },
  { path: '/local-models?tab=agents', name: 'Локальные модели — агентам' },
  // Набор панели: вкладка на тип элемента, режимы по CLI сверху. Окно правки
  // открывается чтением файла — записи нет, обходу можно.
  { path: '/kit', name: 'Набор панели' },
  { path: '/kit?tab=command', name: 'Набор панели — пайплайны' },
  { path: '/kit?tab=rule', name: 'Набор панели — правила' },
  {
    path: '/kit?tab=hook',
    name: 'Набор панели — хуки, окно правки',
    slug: 'kit-editor',
    interact: async (page) => {
      await page
        .getByRole('button', { name: /^(Открыть|Open)$/ })
        .first()
        .click();
      await page
        .getByRole('dialog')
        .waitFor({ timeout: 5000 })
        .catch(() => undefined);
    },
  },
  // Ядро задач (этап 9): без ядра раздел рисует карточку отказа прокладки — её и обходим.
  { path: '/core', name: 'Задачи ядра' },
  { path: '/core/launch', name: 'Запуск задачи ядра' },
  { path: '/core/scenarios', name: 'Сценарии ядра' },
  // Лента задачи — страница с параметром: настоящей задачи на стенде может не быть, поэтому
  // id, вид задачи и поток её журнала отдаёт подмена (`page.route` переживает перезагрузку
  // `prepare`). Маркер — панель сигналов с хотя бы одной строкой: поток дошёл и свернулся.
  {
    path: `/core?id=${CORE_STUB_TASK_ID}`,
    name: 'Задача ядра — лента',
    slug: 'core-task',
    prepare: installCoreTaskStub,
    ready: '[data-core-signal]',
  },
  { path: '/search', name: 'Поиск' },
  { path: '/history', name: 'История изменений — что нового' },
  { path: '/history?tab=config', name: 'История изменений — настройки' },
  { path: '/settings', name: 'Настройки' },
  // Вкладки настроек рисуют по одной панели за раз: обход, открывающий только
  // `/settings`, не видит ни одной, кроме первой. «Интеграции» держат пять
  // форм с полями и переключателями — их проверять надо.
  { path: '/settings?tab=integrations', name: 'Настройки — интеграции' },
  // «Промпты» — единственная вкладка настроек с редактором текста: свой список,
  // своё многострочное поле и две кнопки у каждого промпта.
  { path: '/settings?tab=prompts', name: 'Настройки — промпты' },
  // «Телефон» — кнопки сборки и установки APK, переключатель вопросов с
  // компьютера и блок с командой хука, пока хука нет.
  { path: '/settings?tab=phone', name: 'Настройки — телефон' },
  // «Группы» — карточка рычагов экономии с отметками «Где действует» по каждому CLI:
  // приглушённые отметки и их причины для чтеца проверяются только здесь.
  { path: '/settings?tab=groups', name: 'Настройки — группы' },
  // «Глобальный слой» — таблица сит с кнопками переноса и раскрывающимися
  // случаями; карточка есть всегда, таблица — после первой сверки.
  {
    path: '/settings?tab=globalLayer',
    name: 'Настройки — глобальный слой',
    ready: '[data-global-pair]',
  },
  { path: '/help', name: 'Справка' },
];

/**
 * Переход, переживающий перезапуск стенда: сервер разработки перезапускается от
 * чужих правок, и обход из шестидесяти разделов падал на `ERR_CONNECTION_REFUSED`
 * посреди пути, не сказав ничего о самих разделах. Отказ соединения ждёт стенд
 * до двух минут. `ERR_ABORTED` — переход, сорванный полной перезагрузкой
 * страницы от чужой правки (27.09.2026: обход клавиатуры упал на /env), тоже
 * временный. Любая другая ошибка перехода — настоящая и уходит наверх.
 */
async function gotoWhenUp(page, url) {
  for (let waited = 0; ; waited += 3000) {
    try {
      return await page.goto(url, { waitUntil: 'domcontentloaded' });
    } catch (error) {
      const transient = /ERR_CONNECTION_REFUSED|ERR_EMPTY_RESPONSE|ERR_ABORTED/;
      if (!transient.test(String(error)) || waited >= 120000) throw error;
      await page.waitForTimeout(3000);
    }
  }
}

/**
 * Открывает раздел и доводит его до проверяемого вида: ждёт навигацию, для
 * разделов с `prepare` перезагружает страницу и ждёт маркер `ready`, потом
 * даёт данным раздела догрузиться. Один путь для axe и для клавиатуры, чтобы
 * оба обхода смотрели на одинаковую страницу.
 */
export async function openPanelPage(page, base, { path, prepare, ready, interact }) {
  await gotoWhenUp(page, `${base}${path}`);
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

/**
 * Первая видимая и включённая кнопка создания в содержимом раздела, либо null.
 *
 * Возвращается условие, а не номер: локатор ищет кнопку заново при каждом
 * действии. Прежний `nth(i)` после перерисовки раздела (перед кнопкой встала
 * скрытая с тем же текстом) указывал уже на другой узел, и `focus()` ждал
 * невидимку до таймаута — обход клавиатуры падал на /rules?tab=disabled.
 */
export async function findCreateButton(page) {
  const button = page
    .locator('main')
    .getByRole('button', { name: CREATE_BUTTON })
    .filter({ visible: true })
    .and(page.locator(':not([disabled]):not([aria-disabled="true"])'))
    .first();
  return (await button.count()) > 0 ? button : null;
}
