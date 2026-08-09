/**
 * Прогон окна «Тесты».
 *
 * Проверяется связка целиком: кнопка есть только у вкладки проекта, окно
 * открывается вкладками-группами, провалившийся кейс видно по списку без
 * раскрытия, отметки превращают «Прогнать» в «Прогнать выбранные», полный
 * перетест уходит на сервер со своим признаком, идущий прогон гасит кнопки и
 * показывает лог, а галочки во время прогона докапывают сами — окно перечитывает
 * список, пока агент пишет статусы в файлы.
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
/** Сколько раз окно перечитало список: по нему видно, что опрос идёт. */
let reads = 0;
/** Дописано ли соглашение в CLAUDE.md — сервер здесь подменён. */
let hasConvention = false;

const testCase = (id, title, status, extra = {}) => ({
  id,
  title,
  steps: ['открыть чат', 'нажать «Отправить»'],
  expected: 'сообщение ушло',
  status,
  source: 'agent',
  ...extra,
});

/** Снимок списка. Меняется по ходу прогона — как его меняет настоящий агент. */
let view = {
  projectPath: PROJECT.path,
  dir: '.agent/tests',
  hasConvention: false,
  groups: [
    {
      id: 'gui',
      title: 'GUI',
      file: '.agent/tests/gui.tests.json',
      cases: [
        testCase('gui-001', 'Отправка сообщения', 'passed', { area: 'чат' }),
        testCase('gui-002', 'Пустой ввод не отправляется', 'failed', {
          note: 'кнопка осталась активной',
        }),
        testCase('gui-003', 'Переключение вкладок', 'unknown'),
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
        lastActivity: '2026-08-09T10:00:00.000Z',
        chats: [],
      },
    ],
  }),
);

await page.route('**/api/project-tests/run*', async (route) => {
  started = route.request().postDataJSON();
  view = {
    ...view,
    run: {
      id: 'run-1',
      projectPath: PROJECT.path,
      mode: started.mode,
      status: 'running',
      startedAt: '2026-08-09T10:00:00.000Z',
      log: 'осматриваю приложение',
      tokens: 0,
      costUsd: 0,
    },
  };
  return route.fulfill({ json: view });
});

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
        { ...testCase('gui-004', input.title, 'unknown'), steps: input.steps, source: 'human' },
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

await page.goto(`${BASE}/chat`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('nav');
await page.waitForTimeout(1500);

check(
  (await page.getByRole('button', { name: 'Тесты', exact: true }).count()) === 0,
  'на домашней вкладке кнопки «Тесты» нет',
);

await page.getByRole('tab', { name: 'Проекты' }).click();
await page.waitForTimeout(800);
await page
  .getByRole('button', { name: new RegExp(PROJECT.name) })
  .first()
  .click();
await page.waitForTimeout(1500);

const openButton = page.getByRole('button', { name: 'Тесты', exact: true }).first();
check((await openButton.count()) > 0, 'у вкладки проекта кнопка «Тесты» есть');
await openButton.click();
await page.waitForTimeout(1200);

const dialog = page.getByRole('dialog');
check((await dialog.count()) > 0, 'окно открылось');
check(
  (await dialog.getByText('.agent/tests', { exact: false }).count()) > 0,
  'в подписи окна сказано, где лежат кейсы',
);

// Вкладки-группы: файл — это и есть вкладка, счётчик кейсов в названии.
check((await dialog.getByRole('button', { name: 'GUI (3)' }).count()) > 0, 'вкладка GUI со счётом');
check((await dialog.getByRole('button', { name: 'E2E (1)' }).count()) > 0, 'вкладка E2E со счётом');

// Пульт: поле пожелания и кнопки читаются ОДНОЙ строкой, и рамка поля не
// срезана краем окна — ровно то, что чинилось после первого показа.
const bar = dialog.locator('[class*="_bar_"]').first();
const geometry = await bar.evaluate((node) => {
  const field = node.querySelector('input');
  const buttons = [...node.querySelectorAll('button')].filter((item) =>
    ['Сгенерировать кейсы', 'Прогнать', 'Полный перетест'].includes(item.textContent.trim()),
  );
  const box = field.getBoundingClientRect();
  const layout = node.closest('[class*="_layout_"]').getBoundingClientRect();
  return {
    rows: new Set(
      [box, ...buttons.map((item) => item.getBoundingClientRect())].map((r) => Math.round(r.top)),
    ).size,
    buttons: buttons.length,
    left: Math.round(box.left - layout.left),
    height: Math.round(box.height),
  };
});
check(geometry.buttons === 3, `кнопки пульта на месте: ${geometry.buttons}`);
check(geometry.rows === 1, `поле и кнопки на одной строке: рядов ${geometry.rows}`);
check(geometry.left >= 1, `рамка поля не срезана краем окна: отступ ${geometry.left}px`);
check(geometry.height >= 32, `поле нормальной высоты: ${geometry.height}px`);

// Провалившийся кейс виден по списку, не раскрывая его.
check(
  (await dialog.locator('[class*="_rowFailed_"]').count()) === 1,
  'провалившийся кейс выделен рамкой',
);
check((await dialog.getByText('пройден').count()) > 0, 'статусы кейсов подписаны');

// Раскрытие показывает шаги и то, что агент увидел на самом деле.
await dialog.getByRole('button', { name: /Пустой ввод не отправляется/ }).click();
await page.waitForTimeout(400);
check(
  (await dialog.getByText('кнопка осталась активной').count()) > 0,
  'в раскрытом кейсе видно, что увидел агент',
);
check((await dialog.getByText('нажать «Отправить»').count()) > 0, 'шаги кейса показаны');

// Сломанная группа гасит ТОЛЬКО себя.
await dialog.getByRole('button', { name: 'broken (0)' }).click();
await page.waitForTimeout(500);
check(
  (await dialog.getByText(/Файл группы не разобрался/).count()) > 0,
  'сломанная группа объясняет себя',
);
await dialog.getByRole('button', { name: 'GUI (3)' }).click();
await page.waitForTimeout(500);
check(
  (await dialog.locator('[class*="_row_"]').count()) > 0,
  'остальные группы после сломанной работают',
);

// Соглашение для чата: сначала предупреждение, после нажатия — подтверждение.
check(
  (await dialog.getByText('Из чата кейсы не ведутся').count()) > 0,
  'окно честно говорит, что чат кейсы не ведёт',
);
await dialog.getByRole('button', { name: 'Вписать в CLAUDE.md проекта' }).click();
await page.waitForTimeout(800);
check(hasConvention, 'нажатие ушло на сервер');
check(
  (await dialog.getByText(/Кейсы ведутся и из чата/).count()) > 0,
  'после записи окно показывает, что чат кейсы ведёт',
);

// Отметки меняют смысл кнопки запуска.
await dialog.locator('input[type="checkbox"]').first().check();
await page.waitForTimeout(300);
check(
  (await dialog.getByRole('button', { name: 'Прогнать выбранные (1)' }).count()) > 0,
  'отмеченные кейсы видны на кнопке запуска',
);

await dialog.getByRole('button', { name: 'Полный перетест' }).click();
await page.waitForTimeout(1000);
check(started?.mode === 'run', `на сервер ушёл прогон: ${started?.mode}`);
check(started?.full === true, 'полный перетест ушёл своим признаком');
check(started?.path === PROJECT.path, 'прогон адресован открытому проекту');

// Идущий прогон: кнопки гаснут, состояние подписано, лог показан.
check(
  await dialog.getByRole('button', { name: 'Сгенерировать кейсы' }).isDisabled(),
  'во время прогона генерация выключена',
);
check(
  (await dialog.getByRole('button', { name: 'Остановить' }).count()) > 0,
  'во время прогона есть чем остановить',
);
check((await dialog.getByText('осматриваю приложение').count()) > 0, 'лог прогона показан');

// Опрос: галочки докапывают сами, без перезагрузки окна.
await page.waitForTimeout(5000);
check(reads >= 3, `окно перечитывает список во время прогона: чтений ${reads}`);
check((await dialog.getByText('кейс gui-003: ок').count()) > 0, 'лог дополняется по ходу прогона');
check(
  (await dialog.locator('[class*="_rowFailed_"]').count()) === 1,
  'провал остался провалом после перечитывания',
);

await dialog.getByRole('button', { name: 'Остановить' }).click();
await page.waitForTimeout(900);
check(
  (await dialog.getByText('Прогон остановлен').count()) > 0,
  'остановка видна подписью, а не пустотой',
);

// Свой кейс: он помечается как ваш — агенту его удалять запрещено.
await dialog.getByRole('button', { name: 'Добавить тест' }).click();
await page.waitForTimeout(600);
const caseDialog = page.getByRole('dialog').last();
await caseDialog.getByLabel('Что проверяем').fill('Мой кейс');
await caseDialog.getByLabel('Шаги').fill('открыть настройки\nнажать «Сохранить»');
await caseDialog.getByRole('button', { name: 'Сохранить' }).click();
await page.waitForTimeout(1000);
check((await dialog.getByText('Мой кейс').count()) > 0, 'свой кейс появился в списке');
await dialog.getByRole('button', { name: /Мой кейс/ }).click();
await page.waitForTimeout(400);
check((await dialog.getByText('написан вами').count()) > 0, 'свой кейс помечен как ваш');

// Удаление спрашивает и объясняет, что исчезнет.
await dialog
  .locator('[class*="_row_"]')
  .filter({ hasText: 'Мой кейс' })
  .getByRole('button', { name: 'Удалить тест' })
  .click();
await page.waitForTimeout(600);
const confirm = page.getByRole('alertdialog').or(page.getByRole('dialog').last());
check(
  (await confirm.getByText(/Кейс исчезнет из файла группы/).count()) > 0,
  'удаление объясняет последствие',
);
await confirm.getByRole('button', { name: 'Удалить' }).click();
await page.waitForTimeout(900);
check((await dialog.getByText('Мой кейс').count()) === 0, 'кейс удалён из списка');

check(problems.length === 0, `ошибок в консоли нет: ${problems.slice(0, 3).join(' | ')}`);

await browser.close();
console.log(bad === 0 ? '\nОкно тестов в порядке.' : `\nПроблем: ${bad}`);
process.exit(bad === 0 ? 0 : 1);
