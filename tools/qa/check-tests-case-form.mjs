/**
 * Кейс testing-002: кейс, заведённый формой «Добавить тест» со всеми полями,
 * переживает перезагрузку, и в файле группы он записан с `source: human`.
 *
 * Путь настоящий: форма одноразового стенда → POST панели → файл группы
 * временного проекта; после F5 форма открывается заново и читается обратно.
 * Проверяется каждое заполненное поле и ПОРЯДОК шагов — потеря одного поля
 * или перестановка шагов и есть тот дефект, ради которого кейс заведён.
 *
 * Запуск: `node tools/qa/check-tests-case-form.mjs` (стенд поднимается сам).
 */
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { runOnStand, wait } from './throwaway-stand.mjs';

const CASE = {
  title: 'Проба формы: отправка сообщения',
  purpose: 'Сообщение не теряется при отправке',
  area: 'Чат',
  precondition: 'Открыт пустой разговор',
  steps: [
    { action: 'Ввести «пинг»', expected: 'Текст в поле' },
    { action: 'Нажать Enter', expected: 'Поле пустеет' },
    { action: 'Дождаться ответа', expected: 'Ответ в ленте' },
  ],
  expected: 'Одно сообщение и один ответ',
  priority: 'high',
  tags: ['проба', 'форма'],
};

await runOnStand(
  {
    label: 'tests-case-form',
    seed: ({ home }) => mkdirSync(join(home, 'proj', '.agent', 'tests'), { recursive: true }),
  },
  async (stand, check) => {
    const project = join(stand.home, 'proj');
    const groupFile = join(project, '.agent', 'tests', 'probe.tests.json');
    await stand.api('/projects', { method: 'POST', body: { path: project } });
    const group = await stand.api('/project-tests/group', {
      method: 'POST',
      body: { path: project, id: 'probe', title: 'Проба' },
    });
    check(
      'группа «probe» заведена',
      group.status === 200,
      `${group.status} ${group.text.slice(0, 200)}`,
    );

    const browser = await chromium.launch();
    try {
      const page = await stand.newPage(browser, { height: 1100 });
      await page.goto(`${stand.webUrl}/tests`, { waitUntil: 'domcontentloaded' });
      const add = page.getByRole('button', { name: 'Добавить тест' }).first();
      await add.waitFor({ timeout: 30_000 });
      await add.click();
      const form = page.getByRole('dialog', { name: 'Новый тест' });
      await form.waitFor();

      await form.getByLabel('Что проверяем').fill(CASE.title);
      await form.getByLabel('Зачем').fill(CASE.purpose);
      await form.getByLabel('Зона').fill(CASE.area);
      await form.getByLabel('Предусловие').fill(CASE.precondition);
      await form.getByLabel('Важность').selectOption(CASE.priority);
      for (let index = 0; index < CASE.steps.length; index += 1) {
        const action = form.getByLabel(`Шаг ${index + 1}`, { exact: true });
        if ((await action.count()) === 0) {
          await form.getByRole('button', { name: 'Добавить шаг' }).click();
        }
        await action.fill(CASE.steps[index].action);
        await form.getByLabel('Ожидание шага').nth(index).fill(CASE.steps[index].expected);
      }
      await form.getByLabel('Ожидаемый результат').fill(CASE.expected);
      await form.getByLabel('Теги').fill(CASE.tags.join(', '));
      await form.getByRole('button', { name: 'Сохранить' }).click();
      await form.waitFor({ state: 'hidden', timeout: 10_000 }).catch(() => undefined);
      check('форма закрылась после сохранения', !(await form.isVisible()));
      check('кейс в таблице', (await page.getByText(CASE.title, { exact: true }).count()) > 0);

      // Файл группы — оракул кейса.
      const saved = JSON.parse(readFileSync(groupFile, 'utf8')).cases ?? [];
      const item = saved.find((entry) => entry.title === CASE.title);
      check(
        'в файле группы ровно один новый кейс',
        saved.length === 1 && Boolean(item),
        `кейсов: ${saved.length}`,
      );
      if (item) {
        check('в файле source = human', item.source === 'human', `source: ${item.source}`);
        for (const key of ['purpose', 'area', 'precondition', 'expected', 'priority']) {
          check(
            `в файле поле ${key} цело`,
            item[key] === CASE[key],
            `${key}: ${JSON.stringify(item[key])}`,
          );
        }
        check(
          'в файле теги те же',
          JSON.stringify(item.tags) === JSON.stringify(CASE.tags),
          JSON.stringify(item.tags),
        );
        check(
          'в файле три шага в том же порядке, с ожиданиями',
          JSON.stringify(
            (item.steps ?? []).map(({ action, expected }) => ({ action, expected })),
          ) === JSON.stringify(CASE.steps),
          JSON.stringify(item.steps),
        );
      }

      // F5 и открыть кейс — все поля на месте, шаги в том же порядке.
      await page.reload({ waitUntil: 'domcontentloaded' });
      const row = page.getByRole('row').filter({ hasText: CASE.title });
      await row.waitFor({ timeout: 30_000 });
      await row.getByRole('button', { name: 'Правка теста' }).click();
      const edit = page.getByRole('dialog', { name: 'Правка теста' });
      await edit.waitFor();
      await wait(300);
      const value = (label, options) => edit.getByLabel(label, options).inputValue();
      const shown = {
        title: await value('Что проверяем'),
        purpose: await value('Зачем'),
        area: await value('Зона'),
        precondition: await value('Предусловие'),
        expected: await value('Ожидаемый результат'),
        priority: await value('Важность'),
        tags: await value('Теги'),
      };
      for (const key of ['title', 'purpose', 'area', 'precondition', 'expected', 'priority']) {
        check(
          `после F5 поле «${key}» на месте`,
          shown[key] === CASE[key],
          `${key}: ${JSON.stringify(shown[key])}`,
        );
      }
      check(
        'после F5 теги на месте',
        shown.tags
          .split(',')
          .map((tag) => tag.trim())
          .join('|') === CASE.tags.join('|'),
        shown.tags,
      );
      const steps = [];
      for (let index = 0; index < CASE.steps.length + 1; index += 1) {
        const action = edit.getByLabel(`Шаг ${index + 1}`, { exact: true });
        if ((await action.count()) === 0) break;
        steps.push({
          action: await action.inputValue(),
          expected: await edit.getByLabel('Ожидание шага').nth(index).inputValue(),
        });
      }
      check(
        'после F5 три шага в том же порядке',
        JSON.stringify(steps) === JSON.stringify(CASE.steps),
        JSON.stringify(steps),
      );
      check(
        'страница без необработанных ошибок',
        page.errors.length === 0,
        page.errors.join(' | '),
      );
    } finally {
      await browser.close();
    }
  },
);
