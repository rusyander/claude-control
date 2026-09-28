/**
 * Кейс testing-001: группа заводится с идентификатором — именем файла, а
 * неверный идентификатор и дубль отклоняются с объяснением.
 *
 * Путь настоящий: окно «Новая группа» на странице «Тестирование» одноразового
 * стенда → POST панели → файл в `.agent/tests` временного проекта. Оракул —
 * список файлов каталога, как и записано в кейсе: надпись на экране без файла
 * ничего не доказывает, файл без надписи — тоже.
 *
 * Запуск: `node tools/qa/check-tests-group-create.mjs` (стенд поднимается сам).
 */
import { mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { runOnStand, wait } from './throwaway-stand.mjs';

const files = (dir) =>
  readdirSync(dir)
    .filter((name) => name.endsWith('.tests.json'))
    .sort();

await runOnStand(
  {
    label: 'tests-group',
    seed: ({ home }) => mkdirSync(join(home, 'proj', '.agent', 'tests'), { recursive: true }),
  },
  async (stand, check) => {
    const project = join(stand.home, 'proj');
    const testsDir = join(project, '.agent', 'tests');
    const added = await stand.api('/projects', { method: 'POST', body: { path: project } });
    check(
      'временный проект заведён в реестр',
      added.status === 200,
      `${added.status} ${added.text}`,
    );

    const browser = await chromium.launch();
    try {
      const page = await stand.newPage(browser);
      await page.goto(`${stand.webUrl}/tests`, { waitUntil: 'domcontentloaded' });
      const addGroup = page.getByRole('button', { name: 'Новая группа' });
      await addGroup.waitFor({ timeout: 30_000 });
      const before = files(testsDir);

      /** Открыть окно, ввести идентификатор, сохранить; вернуть окно (или null, если закрылось). */
      const submit = async (id) => {
        await addGroup.click();
        const dialog = page.getByRole('dialog', { name: 'Новая группа' });
        await dialog.waitFor();
        await dialog.getByRole('textbox', { name: /Идентификатор/ }).fill(id);
        await dialog.getByRole('button', { name: 'Сохранить' }).click();
        await wait(1200);
        return (await dialog.isVisible()) ? dialog : null;
      };

      // 1. «smoke» — вкладка и файл smoke.tests.json.
      const first = await submit('smoke');
      check('«smoke»: окно закрылось после сохранения', first === null);
      const afterSmoke = files(testsDir);
      check(
        '«smoke»: в .agent/tests появился ровно smoke.tests.json',
        JSON.stringify(afterSmoke) === JSON.stringify([...before, 'smoke.tests.json'].sort()),
        `было ${JSON.stringify(before)}, стало ${JSON.stringify(afterSmoke)}`,
      );
      const saved = JSON.parse(readFileSync(join(testsDir, 'smoke.tests.json'), 'utf8'));
      const title = saved.title;
      check(
        '«smoke»: название группы записано в файл',
        typeof title === 'string' && title.length > 0,
      );
      check(
        '«smoke»: вкладка группы видна на странице',
        (await page.getByText(title, { exact: true }).count()) > 0,
        `на странице нет «${title}»`,
      );

      // 2. «Моя группа!» — отказ с объяснением формата, файла нет.
      const bad = await submit('Моя группа!');
      check('«Моя группа!»: окно осталось открытым', bad !== null);
      const badText = bad ? await bad.innerText() : '';
      check(
        '«Моя группа!»: отказ объясняет формат (латиница, цифры, дефис)',
        /латиниц/i.test(badText) &&
          /цифр/i.test(badText) &&
          /дефис/i.test(badText) &&
          /(в нижнем регистре|до 40)/.test(badText),
        badText.replace(/\s+/g, ' ').slice(0, 300),
      );
      if (bad) await bad.getByRole('button', { name: 'Отмена' }).click();
      check(
        '«Моя группа!»: каталог .agent/tests не изменился',
        JSON.stringify(files(testsDir)) === JSON.stringify(afterSmoke),
        JSON.stringify(files(testsDir)),
      );

      // 3. Снова «smoke» — отказ «группа уже есть», файл тот же байт в байт.
      const smokeBytes = readFileSync(join(testsDir, 'smoke.tests.json'), 'utf8');
      const dup = await submit('smoke');
      check('повтор «smoke»: окно осталось открытым', dup !== null);
      const dupText = dup ? await dup.innerText() : '';
      check(
        'повтор «smoke»: отказ называет существующую группу',
        /уже есть/.test(dupText) && dupText.includes('smoke'),
        dupText.replace(/\s+/g, ' ').slice(0, 300),
      );
      if (dup) await dup.getByRole('button', { name: 'Отмена' }).click();
      check(
        'повтор «smoke»: файлы и содержимое smoke.tests.json не тронуты',
        JSON.stringify(files(testsDir)) === JSON.stringify(afterSmoke) &&
          readFileSync(join(testsDir, 'smoke.tests.json'), 'utf8') === smokeBytes,
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
