/**
 * Общее для съёмки пачки «Настройка поведения».
 *
 * Подмена здесь ровно одна и названа по причине, а не по удобству: раздел
 * «Плагины» спрашивает установленный `claude` (`claude plugin list --json`,
 * `--available`), то есть кадр зависел бы от того, какие плагины стоят у
 * человека за машиной, и от похода в сеть за репозиториями маркетплейсов.
 * Подменяется ОТВЕТ CLI — разметка, счётчики, диалоги и порядок действий в
 * кадре настоящие.
 *
 * Разделы «Скиллы», «Команды», «Хуки» и «Скрипты» не подменяются ничем: панель
 * читает настоящие файлы одноразового каталога конфигурации и пишет в них же.
 */

/** Открыть раздел панели по адресу и дождаться, пока он дорисуется. */
export async function openSection(page, web, path, pause = 1500) {
  await page.goto(`${web}${path}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('nav');
  await page.waitForTimeout(pause);
}

/**
 * Закрыть модальное окно. Escape закрывает его штатно, но подложка успевает
 * перехватить следующий клик — ждём, пока она уйдёт из разметки.
 */
export async function closeModal(page) {
  await page.keyboard.press('Escape');
  await page.waitForTimeout(1000);
}

/** Установленные плагины — то, что отдал бы `claude plugin list --json`. */
export const INSTALLED = [
  {
    id: 'code-review@team-tools',
    name: 'code-review',
    marketplace: 'team-tools',
    version: '1.4.0',
    scope: 'user',
    isEnabled: true,
    isInstalled: true,
    description: 'Разбор правок по шагам команды: чеклист, команда /code-review:review и скилл.',
    installedAt: '2026-08-14T09:20:00.000Z',
    lastUpdated: '2026-09-02T11:05:00.000Z',
  },
  {
    id: 'sql-helper@team-tools',
    name: 'sql-helper',
    marketplace: 'team-tools',
    version: '0.9.2',
    scope: 'user',
    isEnabled: false,
    isInstalled: true,
    description: 'Объясняет план запроса и подсказывает, где узкое место.',
    installedAt: '2026-08-28T16:40:00.000Z',
  },
  {
    id: 'docs-kit@lab-kit',
    name: 'docs-kit',
    marketplace: 'lab-kit',
    version: '2.0.1',
    scope: 'user',
    isEnabled: true,
    isInstalled: true,
    description: 'Сборка документации проекта: шаблоны страниц и проверка ссылок.',
    installedAt: '2026-07-30T08:10:00.000Z',
    installPathMissing: true,
  },
];

/** Подключённые источники — они лежат файлом рядом с реестром. */
export const MARKETPLACES = [
  { name: 'team-tools', source: 'team-tools/claude-plugins' },
  { name: 'lab-kit', source: 'lab-kit/plugins' },
];

/** Каталог доступного: то, за чем CLI ходит в сеть и обновляет репозитории. */
export const CATALOG = [
  {
    id: 'playwright-runner@lab-kit',
    name: 'playwright-runner',
    marketplace: 'lab-kit',
    version: '1.2.0',
    scope: 'user',
    isEnabled: false,
    isInstalled: false,
    description: 'Прогон сценариев браузера и разбор упавших шагов по кадрам.',
    installCount: 1840,
  },
  {
    id: 'commit-commands@lab-kit',
    name: 'commit-commands',
    marketplace: 'lab-kit',
    version: '3.1.4',
    scope: 'user',
    isEnabled: false,
    isInstalled: false,
    description: 'Набор команд вокруг истории правок: черновик сообщения, разбор ветки.',
    installCount: 1220,
  },
  {
    id: 'sql-helper@team-tools',
    name: 'sql-helper',
    marketplace: 'team-tools',
    version: '0.9.2',
    scope: 'user',
    isEnabled: false,
    isInstalled: true,
    description: 'Объясняет план запроса и подсказывает, где узкое место.',
    installCount: 96,
  },
  {
    id: 'notes-sync@lab-kit',
    name: 'notes-sync',
    marketplace: 'lab-kit',
    version: '0.4.0',
    scope: 'user',
    isEnabled: false,
    isInstalled: false,
    description: 'Держит рабочие заметки агента в одном виде между проектами.',
    installCount: 310,
  },
];

/**
 * Ответ CLI о плагинах. `notes` — то, чем панель объясняет неполный список:
 * молчаливый ноль читался бы как «плагинов нет».
 */
export async function plugins(page, { installed = INSTALLED, notes = [] } = {}) {
  await page.route('**/api/plugins', (route) =>
    route.fulfill({
      json: { installed, available: [], marketplaces: MARKETPLACES, notes },
    }),
  );
  await page.route('**/api/plugins/available*', (route) => route.fulfill({ json: CATALOG }));
}

/** Установка по идентификатору: подменяется вывод команды CLI, как есть. */
export async function install(page, result) {
  await page.route('**/api/plugins/install', (route) => route.fulfill({ json: result }));
}

/**
 * Выбор папки и создание каркаса. Настоящий обзор диска показал бы каталоги
 * машины, на которой идёт съёмка, поэтому дерево тоже подменено — папка,
 * которую увидит человек, выдумана.
 */
export async function folderPicker(page, dir) {
  await page.route('**/api/fs/roots', (route) =>
    route.fulfill({ json: [{ name: 'work', path: 'C:/work' }] }),
  );
  await page.route('**/api/fs/list*', (route) =>
    route.fulfill({
      json: {
        path: 'C:/work',
        entries: [
          { name: 'claude-help-plugins', path: dir },
          { name: 'orders-panel', path: 'C:/work/orders-panel' },
        ],
      },
    }),
  );
}
