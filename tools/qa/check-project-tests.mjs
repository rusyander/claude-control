/**
 * Прогон раздела «Тесты» — библиотека кейсов.
 *
 * Проверяется связка целиком: раздел открывается вкладками-группами, у кейса
 * видны атрибуты, по которым его отбирают (тип, важность, метки), отбор
 * действительно сужает список, раскрытый кейс показывает шаги ВМЕСТЕ с
 * ожиданием каждого шага, сломанная группа гасит только себя, отметки меняют
 * смысл кнопки запуска, полный перетест уходит своим признаком, идущий прогон
 * гасит кнопки и показывает лог, а галочки во время прогона докапывают сами —
 * страница перечитывает список, пока агент пишет статусы в файлы.
 *
 * Данные подменяются на лету: настоящий прогон спавнит CLI и ходит по чужому
 * приложению — на чужой машине это невоспроизводимо. Тем же приёмом живут
 * `check-attention.mjs`, `check-provider-chat.mjs` и `check-project-code.mjs`.
 *
 * Запуск: `node tools/qa/check-project-tests.mjs` при поднятом `pnpm dev`.
 */
import { chromium } from 'playwright';
import { bypassOnboarding } from './bypass-onboarding.mjs';

const BASE = process.env.APP_URL ?? 'http://localhost:8888';
const PROJECT = { name: 'QA проект', path: 'C:/qa-project' };

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
await bypassOnboarding(page);

const problems = [];
page.on('pageerror', (error) => problems.push(error.message));
page.on('console', (message) => message.type() === 'error' && problems.push(message.text()));

/** Что ушло на запуск прогона — по нему проверяется пульт. */
let started;
/** Сколько раз страница перечитала список: по нему видно, что опрос идёт. */
let reads = 0;
/** Дописано ли соглашение в CLAUDE.md — сервер здесь подменён. */
let hasConvention = false;

const step = (action, expected) => ({ action, expected });

const testCase = (id, title, status, extra = {}) => ({
  id,
  type: 'case',
  title,
  steps: [step('открыть чат', 'открылась лента'), step('нажать «Отправить»', 'сообщение ушло')],
  expected: 'сообщение ушло',
  priority: 'medium',
  readiness: 'ready',
  tags: [],
  status,
  source: 'agent',
  ...extra,
});

/** Снимок списка. Меняется по ходу прогона — как его меняет настоящий агент. */
let view = {
  projectPath: PROJECT.path,
  dir: '.agent/tests',
  hasConvention: false,
  sharedSteps: [],
  environments: [],
  schema: { attributes: [], statuses: [] },
  views: [],
  plans: [],
  branch: 'qa/branch',
  commit: 'abcdef1234567890',
  groups: [
    {
      id: 'gui',
      title: 'GUI',
      file: '.agent/tests/gui.tests.json',
      cases: [
        testCase('gui-001', 'Отправка сообщения', 'passed', {
          area: 'чат',
          section: 'Чат/Отправка',
          priority: 'high',
          tags: ['смоук'],
        }),
        testCase('gui-002', 'Пустой ввод не отправляется', 'failed', {
          note: 'кнопка осталась активной',
          priority: 'blocker',
          tags: ['регресс'],
          lastRunAt: '2026-09-01T10:00:00.000Z',
        }),
        testCase('gui-003', 'Переключение вкладок', 'unknown', {
          type: 'checklist',
          priority: 'low',
        }),
      ],
    },
    {
      id: 'e2e',
      title: 'E2E',
      file: '.agent/tests/e2e.tests.json',
      cases: [testCase('e2e-001', 'Полный путь до отчёта', 'unknown')],
    },
    {
      id: 'broken',
      title: 'broken',
      file: '.agent/tests/broken.tests.json',
      cases: [],
      error: 'Unexpected token в позиции 3',
    },
  ],
};

await page.route('**/api/project-git*', async (route) =>
  route.fulfill({
    json: { isRepo: false, detached: false, unborn: false, branches: [], changes: [] },
  }),
);

await page.route('**/api/chats/projects*', async (route) =>
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

/**
 * Порядок регистрации важен: Playwright отдаёт запрос ПОСЛЕДНЕМУ подходящему
 * обработчику, а `**\/project-tests/run*` подходит и к `/runs`. Поэтому общее
 * идёт первым, частное — последним, иначе история молча съела бы запуск.
 */
await page.route('**/api/project-tests/run*', async (route) => {
  // Тот же путь читают, когда открывают запись прогона: GET здесь не запуск.
  if (route.request().method() !== 'POST') return route.fulfill({ json: { run: view.run } });
  started = route.request().postDataJSON();
  view = {
    ...view,
    run: {
      id: 'run-1',
      projectPath: PROJECT.path,
      mode: started.mode,
      actor: 'agent',
      status: 'running',
      startedAt: '2026-09-01T10:00:00.000Z',
      log: 'осматриваю приложение',
      tokens: 0,
      costUsd: 0,
    },
  };
  return route.fulfill({ json: view });
});

// Разделы истории, планов и отчёта отвечают пустотой: этот прогон про
// библиотеку, и молчащий маршрут дал бы 404 в консоль вместо проверки.
await page.route('**/api/project-tests/runs*', async (route) =>
  route.fulfill({ json: { runs: [] } }),
);
await page.route('**/api/project-tests/plans*', async (route) =>
  route.fulfill({ json: { plans: [] } }),
);
await page.route('**/api/project-tests/manual*', async (route) => route.fulfill({ json: {} }));
await page.route('**/api/project-tests/report*', async (route) =>
  route.fulfill({
    json: {
      runs: [],
      areas: [],
      automation: { manual: 0, toAutomate: 0, automated: 0 },
      flaky: [],
      totals: { runs: 0, tokens: 0, costUsd: 0, durationMs: 0 },
    },
  }),
);
await page.route('**/api/project-tests/impact*', async (route) =>
  route.fulfill({ json: { files: [], cases: [] } }),
);
// Здоровье набора считает сервер по файлам проекта — здесь их нет, а молчащий
// маршрут дал бы 400 в консоль вместо проверки.
await page.route('**/api/project-tests/lint*', async (route) =>
  route.fulfill({
    json: {
      findings: [],
      byRule: [],
      duplicates: [],
      checked: 0,
      checkedAt: '2026-09-08T10:00:00.000Z',
    },
  }),
);
// Документ готовности вехи: карточка отчёта спрашивает его, как только у вехи
// есть имя. Без подмены это 400 в консоли, а не пропавшая карточка.
await page.route('**/api/project-tests/release*', async (route) =>
  route.fulfill({ json: { releases: [] } }),
);
await page.route('**/api/project-tests/quarantine*', async (route) =>
  route.fulfill({
    json: {
      lift: [],
      quarantine: [],
      stale: [],
      thresholds: { greenStreak: 5, stability: 70, minRuns: 4 },
      checkedAt: '2026-09-08T10:00:00.000Z',
    },
  }),
);
await page.route('**/api/project-tests/risk*', async (route) =>
  route.fulfill({ json: { items: [], checkedAt: '2026-09-08T10:00:00.000Z' } }),
);

await page.route('**/api/project-tests/stop*', async (route) => {
  view = { ...view, run: { ...view.run, status: 'stopped' } };
  return route.fulfill({ json: view });
});

await page.route('**/api/project-tests/convention*', async (route) => {
  hasConvention = true;
  view = { ...view, hasConvention: true };
  return route.fulfill({ json: view });
});

await page.route('**/api/project-tests/case*', async (route) => {
  const request = route.request();
  const groups = view.groups.map((group) => {
    if (group.id !== 'gui') return group;
    if (request.method() === 'DELETE') {
      const caseId = new URL(request.url()).searchParams.get('caseId');
      return { ...group, cases: group.cases.filter((item) => item.id !== caseId) };
    }
    const input = request.postDataJSON().testCase;
    return {
      ...group,
      cases: [
        ...group.cases,
        {
          ...testCase('gui-004', input.title, 'unknown'),
          steps: input.steps,
          priority: input.priority ?? 'medium',
          source: 'human',
        },
      ],
    };
  });
  view = { ...view, groups };
  return route.fulfill({ json: view });
});

await page.route('**/api/project-tests?*', async (route) => {
  reads += 1;
  // Третье чтение во время прогона отвечает так, как ответил бы сервер после
  // того, как агент прошёл ещё один кейс: галочка должна проступить сама.
  if (reads >= 3 && view.run?.status === 'running') {
    const groups = view.groups.map((group) =>
      group.id === 'gui'
        ? {
            ...group,
            cases: group.cases.map((item) =>
              item.id === 'gui-003' ? { ...item, status: 'passed' } : item,
            ),
          }
        : group,
    );
    view = {
      ...view,
      groups,
      run: { ...view.run, log: 'осматриваю приложение\nкейс gui-003: ок' },
    };
  }
  return route.fulfill({ json: view });
});

let bad = 0;
const check = (ok, text) => {
  console.log(`${ok ? 'ок  ' : 'ПЛОХО'} ${text}`);
  if (!ok) bad += 1;
};

/** Первый непустой локатор из нескольких имён: раздел мог назвать кнопку иначе. */
const anyOf = async (scope, names) => {
  for (const name of names) {
    const locator = scope.getByRole('button', { name }).first();
    if ((await locator.count()) > 0) return locator;
  }
  return undefined;
};

// Проект берётся из ленты рабочих пространств — тем же способом, каким его
// подставляет `panel-pages.mjs`: так проверка не зависит ни от какой истории и
// не открывает настоящий проект.
await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
await page.evaluate(
  (project) =>
    localStorage.setItem(
      'agentdeck:workspace',
      JSON.stringify({
        projectTabs: [{ id: project.path.toLowerCase(), path: project.path, name: project.name }],
        activeTabId: project.path.toLowerCase(),
        views: {},
      }),
    ),
  PROJECT,
);

await page.goto(`${BASE}/tests`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('nav');
await page.waitForTimeout(2000);

const opened = (await page.getByText('.agent/tests', { exact: false }).count()) > 0;
check(opened, 'раздел «Тесты» открылся и говорит, где лежат кейсы');
if (!opened) {
  console.log('\nСтраница раздела не открылась — остальные проверки не выполнялись.');
  await browser.close();
  process.exit(1);
}

const main = page.getByRole('main').or(page.locator('body')).first();

// Вкладки-группы: файл — это и есть вкладка, счётчик кейсов в названии.
check((await main.getByText(/GUI\s*\(3\)/).count()) > 0, 'вкладка GUI со счётом');
check((await main.getByText(/E2E\s*\(1\)/).count()) > 0, 'вкладка E2E со счётом');

// Атрибуты, по которым отбирают, видны без раскрытия кейса.
check((await main.getByText('блокер', { exact: false }).count()) > 0, 'важность видна в списке');
check((await main.getByText(/смоук/).count()) > 0, 'метки видны в списке');
check(
  (await main.getByText('чек-лист', { exact: false }).count()) > 0,
  'тип элемента (чек-лист) виден в списке',
);

// Провалившийся кейс виден по списку, не раскрывая его.
check(
  (await main.getByText('Пустой ввод не отправляется').count()) > 0,
  'провалившийся кейс есть в списке',
);
check((await main.getByText('провален', { exact: false }).count()) > 0, 'статусы кейсов подписаны');

// Отбор: по статусу список сужается, сброс возвращает всё. Статус выбирают
// списком, а не рядом кнопок: статусов шесть, и ряд кнопок съел бы всю строку
// отбора, в которой кроме него ещё тип, важность, метки и поиск.
const statusFilter = main.getByLabel('Статус').first();
if ((await statusFilter.count()) > 0) {
  await statusFilter.selectOption('failed');
  await page.waitForTimeout(600);
  check(
    (await main.getByText('Отправка сообщения').count()) === 0,
    'отбор по статусу убирает пройденные кейсы',
  );
  const reset = await anyOf(main, [/Сбросить отбор/, /Сбросить/, /Сброс/]);
  if (reset) await reset.click();
  await page.waitForTimeout(600);
  check(
    (await main.getByText('Отправка сообщения').count()) > 0,
    'сброс отбора возвращает список целиком',
  );
} else {
  check(false, 'на странице есть отбор по статусу');
}

/**
 * Кейс открывается редактором, а не разворачивается строкой: в нём десятки
 * полей (шаги с ожиданием каждого, предусловие, параметры, свои поля проекта),
 * и внутри строки таблицы это не помещается. Поэтому шаги ищем в диалоге.
 */
await main.getByText('Пустой ввод не отправляется').first().click();
await page.waitForTimeout(800);
const editor = page.getByRole('dialog').first();
check((await editor.count()) > 0, 'кейс открывается редактором');
// Поля редактора — это ЗНАЧЕНИЯ полей ввода, а не текст на экране: искать их
// через getByText значило бы проверять подписи, а не содержимое кейса.
const filled = await editor
  .locator('input, textarea')
  .evaluateAll((nodes) => nodes.map((node) => node.value ?? '').join(' | '));
check(filled.includes('кнопка осталась активной'), 'в открытом кейсе видно, что увидел агент');
check(filled.includes('нажать «Отправить»'), 'шаги кейса показаны');
check(filled.includes('открылась лента'), 'у шага показано его ожидание');
// Закрываем редактор: пока он открыт, до библиотеки под ним не дотянуться.
await page.keyboard.press('Escape');
await page.waitForTimeout(600);

// Сломанная группа гасит ТОЛЬКО себя.
const brokenTab = await anyOf(main, [/broken/]);
if (brokenTab) {
  await brokenTab.click();
  await page.waitForTimeout(700);
  check(
    (await main.getByText(/не разобрал|Unexpected token/).count()) > 0,
    'сломанная группа объясняет себя',
  );
  const guiTab = await anyOf(main, [/GUI/]);
  if (guiTab) await guiTab.click();
  await page.waitForTimeout(700);
  check(
    (await main.getByText('Отправка сообщения').count()) > 0,
    'остальные группы после сломанной работают',
  );
} else {
  check(false, 'сломанная группа показана вкладкой');
}

// Соглашение для чата: сначала предупреждение, после нажатия — подтверждение.
check(
  (await main.getByText(/кейсы не ведутся|не ведёт кейсы/i).count()) > 0,
  'страница честно говорит, что чат кейсы не ведёт',
);
const conventionButton = await anyOf(main, [/CLAUDE\.md/]);
if (conventionButton) {
  await conventionButton.click();
  await page.waitForTimeout(900);
  check(hasConvention, 'нажатие ушло на сервер');
  check(
    (await main.getByText(/ведутся и из чата|из чата/i).count()) > 0,
    'после записи страница показывает, что чат кейсы ведёт',
  );
} else {
  check(false, 'есть кнопка «Вписать в CLAUDE.md проекта»');
}

// Отметки меняют смысл кнопки запуска.
const boxes = main.locator('input[type="checkbox"]');
if ((await boxes.count()) > 0) {
  await boxes.first().check();
  await page.waitForTimeout(400);
  check(
    (await main.getByRole('button', { name: /выбранные|\(1\)/ }).count()) > 0,
    'отмеченные кейсы видны на кнопке запуска',
  );
} else {
  check(false, 'кейсы можно отмечать галочками');
}

const fullButton = await anyOf(main, [/Полный перетест/]);
if (fullButton) {
  await fullButton.click();
  await page.waitForTimeout(1200);
  check(started?.mode === 'run', `на сервер ушёл прогон: ${started?.mode}`);
  check(started?.full === true, 'полный перетест ушёл своим признаком');
  check(started?.path === PROJECT.path, 'прогон адресован открытому проекту');
} else {
  check(false, 'есть кнопка «Полный перетест»');
}

// Идущий прогон: кнопки гаснут, состояние подписано, лог показан.
const generateButton = await anyOf(main, [/Сгенерировать/]);
check(
  generateButton ? await generateButton.isDisabled() : false,
  'во время прогона генерация выключена',
);
check(
  (await main.getByRole('button', { name: /Остановить/ }).count()) > 0,
  'во время прогона есть чем остановить',
);
check((await main.getByText('осматриваю приложение').count()) > 0, 'лог прогона показан');

// Опрос: галочки докапывают сами, без перезагрузки страницы.
await page.waitForTimeout(5000);
check(reads >= 3, `страница перечитывает список во время прогона: чтений ${reads}`);
check((await main.getByText('кейс gui-003: ок').count()) > 0, 'лог дополняется по ходу прогона');

const stopButton = await anyOf(main, [/Остановить/]);
if (stopButton) {
  await stopButton.click();
  await page.waitForTimeout(1000);
  check(
    (await main.getByText(/остановлен/i).count()) > 0,
    'остановка видна подписью, а не пустотой',
  );
}

// Два режима, которые давно есть на сервере: исследование и автоматизация.
// Проверяются они после остановки — во время прогона весь пульт погашен.
const explore = main.getByRole('button', { name: /^Исследовать$/ }).first();
if ((await explore.count()) === 0) {
  check(false, 'в пульте есть «Исследовать»');
} else {
  // Хартия — не украшение задания: сессия без неё превращается в блуждание,
  // поэтому кнопка молчит, пока поле пожелания пусто.
  check(await explore.isDisabled(), 'без хартии «Исследовать» выключено');
  await main.getByLabel('Пожелание агенту').fill('вложения в чате');
  await page.waitForTimeout(500);
  check(!(await explore.isDisabled()), 'с хартией кнопка включается');
  await explore.click();
  await page.waitForTimeout(1200);
  check(started?.mode === 'explore', `на сервер ушло исследование: ${started?.mode}`);
  check(started?.scope === 'вложения в чате', 'хартия уехала вместе с запуском');
}

// Прогон исследования снова погасил пульт — останавливаем и смотрим вторую кнопку.
const stopExplore = await anyOf(main, [/Остановить/]);
if (stopExplore) {
  await stopExplore.click();
  await page.waitForTimeout(900);
}

const automate = main.getByRole('button', { name: /^Автоматизировать \(\d+\)$/ }).first();
if ((await automate.count()) === 0) {
  check(false, 'в пульте есть «Автоматизировать» с числом кейсов');
} else {
  // Число на кнопке — это работа режима: кейсы, которых ещё нет в коде.
  check(true, 'кнопка автоматизации называет, сколько кейсов ещё не в коде');
  await automate.click();
  await page.waitForTimeout(1200);
  check(started?.mode === 'automate', `на сервер ушла автоматизация: ${started?.mode}`);
}

check(problems.length === 0, `ошибок в консоли нет: ${problems.slice(0, 3).join(' | ')}`);

await browser.close();
console.log(bad === 0 ? '\nБиблиотека тестов в порядке.' : `\nПроблем: ${bad}`);
process.exit(bad === 0 ? 0 : 1);
