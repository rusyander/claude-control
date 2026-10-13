/**
 * Сценарий «Что нового»: как читать ленту выпусков панели.
 *
 * Вход один: человек открывает «История изменений» и хочет понять, что в панели
 * поменялось. Четыре кадра: лента с записями «в работе» и выпущенными, раскрытый
 * выпуск с полосой областей и коммитами, отбор по источнику и виду и карточка
 * «вышла новая версия» с кнопкой «Обновить».
 *
 * Интерфейс настоящий, подменены два ответа — `/api/changelog` и
 * `/api/panel-update` (состояние клона машины съёмки — её правки и время fetch —
 * в кадр попадать не должно). Лента настоящей
 * панели описывает её собственный репозиторий: её содержимое менялось бы с каждым
 * коммитом, а числа записи «в работе» — это правки машины съёмки. Поэтому записи
 * здесь образцовые, но устроены как настоящие ответы сервера: у описания без
 * коммита чисел нет, правки рабочей копии — отдельная карточка.
 */
import { shotLanguage } from './kit.mjs';
import { settings, location, open, frame } from './watching-stubs.mjs';

// Тема коммита — как её прислал git; в английском кадре образцы тоже английские.
const EN = shotLanguage() === 'en';
const pick = (ru, en) => (EN ? en : ru);

const text = (ru, en) => ({ ru, en });
const counts = (files, insertions, deletions) => ({ files, insertions, deletions });
const commit = (n, subject, date, body) => ({
  hash: `${n}`.padStart(40, 'a'),
  shortHash: `${n}`.padStart(8, 'a'),
  date,
  subject,
  ...(body ? { body } : {}),
  ...counts(4, 60, 8),
});

/** «Последняя версия», проверено в фиксированный момент — кадры не дрожат от часов. */
const UP_TO_DATE = {
  state: 'current',
  branch: 'main',
  upstream: 'origin/main',
  behind: 0,
  ahead: 0,
  incoming: [],
  entries: [],
  dirty: [],
  lockChanged: false,
  fetchedAt: '2026-10-14T07:00:00.000Z',
};

/** Вышли три коммита с описанием выпуска и новым lock-файлом. */
const BEHIND = {
  ...UP_TO_DATE,
  state: 'behind',
  behind: 3,
  incoming: [1, 2, 3].map((n) => ({
    hash: `${n}`.padStart(40, 'd'),
    date: '2026-10-14T09:30:00+05:00',
    subject: `feat: ${n}`,
  })),
  entries: [
    {
      id: '2026-10-14-sample-pending',
      title: text('Поиск по вкладкам окна', 'Search across window tabs'),
    },
  ],
  lockChanged: true,
};

function sampleResponse() {
  const entries = [
    {
      id: '2026-10-14-sample-pending',
      source: 'curated',
      status: 'pending',
      date: '2026-10-14T09:30:00+05:00',
      kind: 'added',
      title: text('Поиск по вкладкам окна', 'Search across window tabs'),
      summary: text(
        'Строка поиска над вкладками окна находит нужную по названию.',
        'A search line above the window tabs finds the one you need by name.',
      ),
      items: [
        {
          kind: 'added',
          text: text('Строка поиска над вкладками', 'A search line above the tabs'),
          how: text(
            'Начните вводить название — лишние вкладки скроются.',
            'Start typing a name — other tabs hide.',
          ),
          area: text('Окно', 'Window'),
          images: [],
        },
        {
          kind: 'fixed',
          text: text(
            'Фокус возвращается на вкладку после закрытия окна',
            'Focus returns to the tab after the window closes',
          ),
          images: [],
        },
      ],
      images: [],
      links: [],
      commits: [],
      areas: [],
      totals: counts(0, 0, 0),
    },
    {
      id: 'working-tree',
      source: 'tree',
      status: 'pending',
      date: '2026-10-14T09:45:00+05:00',
      kind: 'changed',
      title: text('working-tree'),
      items: [],
      images: [],
      links: [],
      commits: [],
      areas: [
        { area: 'web', files: 5, insertions: 210, deletions: 18 },
        { area: 'tests', files: 2, insertions: 64, deletions: 0 },
      ],
      totals: counts(7, 274, 18),
    },
    {
      id: '2026-10-12-sample-released',
      source: 'curated',
      status: 'released',
      date: '2026-10-12T18:20:00+05:00',
      kind: 'improved',
      title: text('Быстрее открывается список проектов', 'The project list opens faster'),
      summary: text(
        'Список проектов больше не ждёт чтения всех транскриптов.',
        'The project list no longer waits for every transcript to be read.',
      ),
      items: [
        {
          kind: 'improved',
          text: text(
            'Список проектов открывается без ожидания',
            'The project list opens without waiting',
          ),
          images: [],
        },
        {
          kind: 'fixed',
          text: text(
            'Исправлен счётчик сессий у переименованного проекта',
            'Fixed the session counter of a renamed project',
          ),
          images: [],
        },
        {
          kind: 'internal',
          text: text(
            'Чтение транскриптов вынесено в отдельный модуль',
            'Transcript reading moved to its own module',
          ),
          images: [],
        },
      ],
      images: [],
      links: [],
      commits: [
        commit(
          11,
          pick(
            'perf(projects): список без чтения транскриптов',
            'perf(projects): list without reading transcripts',
          ),
          '2026-10-12T18:20:00+05:00',
          pick(
            '- список строится по именам файлов, транскрипты не читаются\n- первое открытие: 3,2 с → 0,3 с',
            '- the list is built from file names, transcripts are not read\n- first open: 3.2 s → 0.3 s',
          ),
        ),
        commit(
          12,
          pick(
            'fix(projects): счётчик сессий переименованного проекта',
            'fix(projects): session counter of a renamed project',
          ),
          '2026-10-12T14:05:00+05:00',
        ),
      ],
      areas: [
        { area: 'web', files: 3, insertions: 120, deletions: 40 },
        { area: 'server', files: 4, insertions: 95, deletions: 30 },
        { area: 'tests', files: 2, insertions: 60, deletions: 4 },
      ],
      totals: counts(9, 275, 74),
    },
  ];
  const gitRows = [
    [
      'fixed',
      'Не терялся фокус в поле чата',
      'Chat field no longer loses focus',
      '2026-10-11T12:00:00+05:00',
    ],
    [
      'docs',
      'Уточнён раздел про токен доступа',
      'The access token section clarified',
      '2026-10-10T16:30:00+05:00',
    ],
    ['internal', 'Тесты разбиты по областям', 'Tests split by area', '2026-10-09T11:10:00+05:00'],
    [
      'fixed',
      'Корректная дата у записей без часового пояса',
      'Correct date for entries without a timezone',
      '2026-10-08T10:00:00+05:00',
    ],
  ];
  gitRows.forEach(([kind, ru, en, date], i) => {
    entries.push({
      id: `git-${String(i).padStart(8, '0')}`,
      source: 'git',
      status: 'released',
      date,
      kind,
      title: text(ru, en),
      items: [],
      images: [],
      links: [],
      commits: [commit(100 + i, `${kind}: ${pick(ru, en)}`, date)],
      areas: [{ area: kind === 'docs' ? 'docs' : 'web', files: 2, insertions: 24, deletions: 6 }],
      totals: counts(2, 24, 6),
    });
  });
  return { entries, gitAvailable: true, invalid: [] };
}

export async function shootChangelog(browser, web, scenario) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });

  try {
    await settings(page);
    await location(page);
    await page.route('**/api/changelog', (route) => route.fulfill({ json: sampleResponse() }));
    let update = UP_TO_DATE;
    await page.route(/\/api\/panel-update(\?.*)?$/, (route) => route.fulfill({ json: update }));

    // ── 01. Лента: в работе — сверху, выпущенное — ниже ──────────────────────
    await open(page, web, '/history', 1500);
    await page.waitForSelector('button[data-changelog-entry]');
    await frame(scenario, page, '01-feed');

    // ── 02. Раскрытый выпуск: пункты, что затронуто, коммиты ─────────────────
    await page.locator('button[data-changelog-entry="working-tree"]').click();
    await page.locator('button[data-changelog-entry="2026-10-12-sample-released"]').click();
    await page.getByRole('button', { name: /^(Коммиты|Commits) \(2\)/ }).click();
    await page.waitForTimeout(600);
    await frame(scenario, page, '02-entry');

    // ── 03. Отбор: источник и вид сужают ленту вместе ────────────────────────
    await page.getByRole('button', { name: /^(Из git|From git)$/ }).click();
    await page.getByRole('button', { name: /^(Исправлено|Fixed)/ }).click();
    await page.waitForTimeout(600);
    await frame(scenario, page, '03-filter');

    // ── 04. Вышла новая версия: что придёт и «Обновить» ──────────────────────
    update = BEHIND;
    await open(page, web, '/history', 1500);
    await page.waitForSelector('[data-panel-update="behind"]');
    await frame(scenario, page, '04-update');
  } finally {
    await page.close();
  }
}
