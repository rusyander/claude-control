/**
 * Кейс projects-copies-001: проект добавляется выбором папки («Добавить
 * проект» → по папкам → «Открыть эту папку»), счётчик «Проектов: N» растёт,
 * проект появляется в селекте «Проект» раздела «Тестирование», а повторное
 * добавление той же папки не заводит вторую запись.
 *
 * Путь настоящий: обзор папок одноразового стенда идёт по настоящему диску от
 * корня «~» — это временный дом стенда, в нём засеяна папка проекта. Оракул
 * «одна запись» — реестр панели (GET /api/projects), а не только экран.
 *
 * Запуск: `node tools/qa/check-project-add.mjs` (стенд поднимается сам).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { runOnStand, wait } from './throwaway-stand.mjs';

const FOLDER = 'probe-project';

await runOnStand(
  {
    label: 'project-add',
    seed: ({ home }) => {
      mkdirSync(join(home, FOLDER), { recursive: true });
      writeFileSync(join(home, FOLDER, 'AGENTS.md'), '# probe\n', 'utf8');
    },
  },
  async (stand, check) => {
    const registry = async () => (await stand.api('/projects')).body ?? [];
    const browser = await chromium.launch();
    try {
      const page = await stand.newPage(browser, { height: 1100 });
      await page.goto(`${stand.webUrl}/projects`, { waitUntil: 'domcontentloaded' });
      const count = async () => {
        const text = await page
          .getByText(/^Проектов: \d+$/)
          .innerText()
          .catch(() => 'Проектов: 0');
        return Number(text.split(':')[1]);
      };
      await page
        .getByRole('button', { name: 'Добавить проект' })
        .first()
        .waitFor({ timeout: 30_000 });
      const before = await count();

      /** Пройти обзор папок от «~» до папки проекта и открыть её. */
      const pickFolder = async () => {
        await page.getByRole('button', { name: 'Добавить проект' }).first().click();
        const picker = page.getByRole('dialog', { name: 'Выбор папки проекта' });
        await picker.waitFor();
        await picker.getByRole('button', { name: '~', exact: true }).first().click();
        await picker.getByRole('button', { name: FOLDER }).click();
        await picker.getByRole('button', { name: 'Открыть эту папку' }).click();
        await picker.waitFor({ state: 'hidden', timeout: 10_000 }).catch(() => undefined);
        await wait(1000);
      };

      await pickFolder();
      const after = await count();
      const list = await registry();
      const mine = list.filter((item) => item.path.toLowerCase().endsWith(FOLDER));
      check(`счётчик вырос: ${before} → ${after}`, after === before + 1);
      check('в реестре ровно одна запись на эту папку', mine.length === 1, JSON.stringify(list));
      check(
        'проект в списке раздела',
        (await page.getByRole('button', { name: new RegExp(FOLDER) }).count()) > 0,
      );

      // «Тестирование» — проект в селекте «Проект».
      await page.goto(`${stand.webUrl}/tests`, { waitUntil: 'domcontentloaded' });
      const select = page.getByLabel('Проект', { exact: true });
      await select.waitFor({ timeout: 30_000 }).catch(() => undefined);
      const options =
        (await select.count()) > 0 ? await select.locator('option').allInnerTexts() : [];
      check(
        '«Тестирование»: проект есть в селекте «Проект»',
        options.includes(FOLDER),
        JSON.stringify(options),
      );

      // Та же папка ещё раз — дубля нет.
      await page.goto(`${stand.webUrl}/projects`, { waitUntil: 'domcontentloaded' });
      await page
        .getByRole('button', { name: 'Добавить проект' })
        .first()
        .waitFor({ timeout: 30_000 });
      await pickFolder();
      const again = (await registry()).filter((item) => item.path.toLowerCase().endsWith(FOLDER));
      check('повтор: в реестре по-прежнему одна запись', again.length === 1, JSON.stringify(again));
      check('повтор: счётчик не вырос', (await count()) === after, `${await count()}`);
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
