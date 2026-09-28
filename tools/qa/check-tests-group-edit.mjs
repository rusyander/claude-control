/**
 * Кейс testing-013: окно «Изменить группу» стирает описание. Пустое поле
 * описания после «Сохранить» — описания в файле группы больше нет; новое
 * описание ложится как набрано; пустое НАЗВАНИЕ, наоборот, не стирает
 * название (без названия у группы не было бы вкладки).
 *
 * Прежде сервер читал пустое описание как «не трогать», и стереть его из
 * панели было нельзя (ревью 28.09, r1-B2): окно слало '', а в файле
 * оставалось старое. Юнит-тест хранилища это ловит, но не видит окна: снятая
 * отправка описания или подстановка старого значения прошли бы мимо.
 *
 * Путь настоящий: кнопка «Изменить группу» на странице «Тестирование»
 * одноразового стенда → POST /project-tests/group/update → файл группы
 * временного проекта. Оракул — файл и заново открытое окно.
 *
 * Запуск: `node tools/qa/check-tests-group-edit.mjs` (стенд поднимается сам).
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { runOnStand, wait } from './throwaway-stand.mjs';

const OLD_DESCRIPTION = 'Старое описание группы';
const NEW_DESCRIPTION = 'Новое описание группы';

await runOnStand(
  {
    label: 'tests-group-edit',
    seed: ({ home }) => {
      const dir = join(home, 'proj', '.agent', 'tests');
      mkdirSync(dir, { recursive: true });
      const group = { version: 1, title: 'Альфа', description: OLD_DESCRIPTION, cases: [] };
      writeFileSync(join(dir, 'alpha.tests.json'), `${JSON.stringify(group, null, 2)}\n`, 'utf8');
    },
  },
  async (stand, check) => {
    const project = join(stand.home, 'proj');
    const file = join(project, '.agent', 'tests', 'alpha.tests.json');
    const saved = () => JSON.parse(readFileSync(file, 'utf8'));
    const added = await stand.api('/projects', { method: 'POST', body: { path: project } });
    check('временный проект заведён в реестр', added.status === 200, `${added.status}`);

    const browser = await chromium.launch();
    try {
      const page = await stand.newPage(browser);
      await page.goto(`${stand.webUrl}/tests`, { waitUntil: 'domcontentloaded' });
      const edit = page.getByRole('button', { name: 'Изменить группу' });
      await edit.first().waitFor({ timeout: 30_000 });

      /** Открыть окно правки, вписать поля (undefined — не трогать), сохранить. */
      const submit = async ({ title, description }) => {
        await edit.first().click();
        const dialog = page.getByRole('dialog', { name: 'Изменить группу' });
        await dialog.waitFor();
        const shown = await dialog.getByRole('textbox', { name: /О чём группа/ }).inputValue();
        if (title !== undefined) {
          await dialog.getByRole('textbox', { name: /^Название/ }).fill(title);
        }
        if (description !== undefined) {
          await dialog.getByRole('textbox', { name: /О чём группа/ }).fill(description);
        }
        await dialog.getByRole('button', { name: 'Сохранить' }).click();
        await dialog.waitFor({ state: 'hidden', timeout: 10_000 }).catch(() => undefined);
        await wait(600);
        return { shown, open: await dialog.isVisible() };
      };

      // 1. Окно показывает текущее описание; пустое поле → описания в файле нет.
      const first = await submit({ description: '' });
      check('окно правки показало текущее описание', first.shown === OLD_DESCRIPTION, first.shown);
      check('окно закрылось после сохранения', !first.open);
      const cleared = saved();
      check(
        'пустое описание стёрто в файле',
        cleared.description === undefined,
        JSON.stringify(cleared.description),
      );
      check('название при этом не тронуто', cleared.title === 'Альфа', cleared.title);

      // 2. Заново открытое окно показывает пустое описание; новое — ложится.
      const second = await submit({ description: NEW_DESCRIPTION });
      check(
        'после стирания окно открывается с пустым описанием',
        second.shown === '',
        second.shown,
      );
      check(
        'новое описание записано в файл',
        saved().description === NEW_DESCRIPTION,
        JSON.stringify(saved().description),
      );

      // 3. Отрицательная сторона: пустое название название не стирает.
      await submit({ title: '' });
      const kept = saved();
      check('пустое название не стёрло название', kept.title === 'Альфа', kept.title);
      check(
        'описание при пустом названии не тронуто',
        kept.description === NEW_DESCRIPTION,
        JSON.stringify(kept.description),
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
