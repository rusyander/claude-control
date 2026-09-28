/**
 * Кейс testing-004: массовые действия — тег, важность, размножение, перенос,
 * архив и восстановление — задевают РОВНО отмеченные кейсы, а счётчик
 * «затронуто» (`touched` в ответе панели) равен их числу.
 *
 * Путь настоящий: отметки и пульт массовых действий на странице «Тестирование»
 * одноразового стенда → POST /project-tests/bulk → файлы двух групп временного
 * проекта. Оракул — файлы обеих групп после каждого шага: отмеченные изменились,
 * неотмеченные остались байт в байт такими, как были.
 *
 * Запуск: `node tools/qa/check-tests-bulk.mjs` (стенд поднимается сам).
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { runOnStand, wait } from './throwaway-stand.mjs';

const TITLES = ['Альфа один', 'Альфа два', 'Альфа три', 'Альфа четыре', 'Альфа пять'];
const PICKED = TITLES.slice(0, 3);

const groupJson = (title, cases) => `${JSON.stringify({ version: 1, title, cases }, null, 2)}\n`;

await runOnStand(
  {
    label: 'tests-bulk',
    seed: ({ home }) => {
      const dir = join(home, 'proj', '.agent', 'tests');
      mkdirSync(dir, { recursive: true });
      const cases = TITLES.map((title, index) => ({
        id: `alpha-00${index + 1}`,
        type: 'case',
        title,
        steps: [{ action: `Шаг ${index + 1}`, expected: `Ожидание ${index + 1}` }],
        expected: 'Всё на месте',
        priority: 'medium',
        tags: ['исходный'],
        status: 'unknown',
        source: 'human',
        updatedAt: '2026-09-20T10:00:00.000Z',
      }));
      writeFileSync(join(dir, 'alpha.tests.json'), groupJson('Альфа', cases), 'utf8');
      writeFileSync(join(dir, 'beta.tests.json'), groupJson('Бета', []), 'utf8');
    },
  },
  async (stand, check) => {
    const project = join(stand.home, 'proj');
    const dir = join(project, '.agent', 'tests');
    const read = (id) => JSON.parse(readFileSync(join(dir, `${id}.tests.json`), 'utf8')).cases;
    const byTitle = (cases, title) => cases.filter((item) => item.title === title);
    await stand.api('/projects', { method: 'POST', body: { path: project } });
    // Неотмеченные — два последних оригинала, по id: копии тоже не входят в PICKED.
    const untouched = () =>
      read('alpha').filter((item) => ['alpha-004', 'alpha-005'].includes(item.id));
    const baseline = JSON.stringify(untouched());

    const browser = await chromium.launch();
    try {
      const page = await stand.newPage(browser, { height: 1100 });
      await page.goto(`${stand.webUrl}/tests`, { waitUntil: 'domcontentloaded' });
      await page
        .getByRole('checkbox', { name: TITLES[0], exact: true })
        .waitFor({ timeout: 30_000 });

      /** Отметить кейсы по названию, выбрать действие и значение, применить; вернуть `touched`. */
      const apply = async (titles, action, fill) => {
        for (const title of titles) {
          await page.getByRole('checkbox', { name: title, exact: true }).first().check();
        }
        await page.getByRole('combobox', { name: 'Действие' }).selectOption(action);
        if (fill) await fill();
        const answer = page.waitForResponse(
          (res) =>
            res.url().includes('/api/project-tests/bulk') && res.request().method() === 'POST',
        );
        await page.getByRole('button', { name: 'Применить' }).click();
        const res = await answer;
        const body = await res.json().catch(() => ({}));
        await wait(600);
        return { status: res.status(), touched: body.touched };
      };
      const same = () => JSON.stringify(untouched()) === baseline;
      /** Тумблер «Показывать архив» живёт в свёрнутой панели фильтров — раскрыть её, если надо. */
      const showArchive = async (on) => {
        const toggle = page.getByRole('switch', { name: 'Показывать архив' });
        if (!(await toggle.isVisible()))
          await page.getByRole('button', { name: /^Фильтры/ }).click();
        if ((await toggle.getAttribute('aria-checked')) !== String(on)) await toggle.click();
      };

      // 1. Тег «bulk» у трёх.
      const tag = await apply(PICKED, 'tag', () =>
        page.getByRole('textbox', { name: 'Тег' }).fill('bulk'),
      );
      let alpha = read('alpha');
      check('тег: touched = 3', tag.status === 200 && tag.touched === 3, JSON.stringify(tag));
      check(
        'тег: у трёх отмеченных есть bulk, исходный тег цел',
        PICKED.every((t) => {
          const tags = byTitle(alpha, t)[0]?.tags ?? [];
          return tags.includes('bulk') && tags.includes('исходный');
        }),
      );
      check('тег: неотмеченные не тронуты', same());

      // 2. Важность low у трёх.
      const low = await apply(PICKED, 'priority', () =>
        page.getByRole('combobox', { name: 'Важность' }).last().selectOption('low'),
      );
      alpha = read('alpha');
      check('важность: touched = 3', low.status === 200 && low.touched === 3, JSON.stringify(low));
      check(
        'важность: у трёх low',
        PICKED.every((t) => byTitle(alpha, t)[0]?.priority === 'low'),
      );
      check('важность: неотмеченные не тронуты', same());

      // 3. Размножить — три копии с новыми id.
      const idsBefore = new Set(alpha.map((item) => item.id));
      const dup = await apply(PICKED, 'duplicate');
      alpha = read('alpha');
      const copies = alpha.filter((item) => !idsBefore.has(item.id));
      check(
        'размножить: touched = 3',
        dup.status === 200 && dup.touched === 3,
        JSON.stringify(dup),
      );
      check(
        'размножить: ровно три новых кейса с новыми уникальными id',
        copies.length === 3 && new Set(alpha.map((item) => item.id)).size === alpha.length,
        `новых: ${copies.map((item) => `${item.id}:${item.title}`).join(', ')}`,
      );
      check(
        'размножить: копии несут шаги своих оригиналов',
        copies.every((copy) =>
          PICKED.some(
            (t) => JSON.stringify(byTitle(alpha, t)[0]?.steps) === JSON.stringify(copy.steps),
          ),
        ),
      );
      check('размножить: неотмеченные не тронуты', same());

      // 4. Перенести копии во вторую группу.
      const copyTitles = copies.map((item) => item.title);
      const copyIds = copies.map((item) => item.id);
      const move = await apply(copyTitles, 'move', () =>
        page.getByRole('combobox', { name: 'Группа-приёмник' }).selectOption('beta'),
      );
      alpha = read('alpha');
      const beta = read('beta');
      check(
        'перенос: touched = 3',
        move.status === 200 && move.touched === 3,
        JSON.stringify(move),
      );
      check(
        'перенос: копий нет в первой группе',
        alpha.length === TITLES.length && !alpha.some((item) => copyIds.includes(item.id)),
        `в alpha: ${alpha.map((item) => item.id).join(', ')}`,
      );
      check(
        'перенос: три копии во второй группе, с тем же содержимым',
        beta.length === 3 &&
          copies.every((copy) =>
            beta.some(
              (item) =>
                item.title === copy.title &&
                JSON.stringify(item.steps) === JSON.stringify(copy.steps),
            ),
          ),
        `в beta: ${beta.map((item) => `${item.id}:${item.title}`).join(', ')}`,
      );
      check('перенос: неотмеченные не тронуты', same());

      // 5. Архив и восстановление трёх оригиналов.
      const beforeArchive = PICKED.map((t) => byTitle(alpha, t)[0]);
      const archive = await apply(PICKED, 'archive');
      alpha = read('alpha');
      check(
        'архив: touched = 3',
        archive.status === 200 && archive.touched === 3,
        JSON.stringify(archive),
      );
      check(
        'архив: у трёх archived',
        PICKED.every((t) => byTitle(alpha, t)[0]?.archived === true),
      );
      const visibleAfter = [];
      for (const t of PICKED) {
        if ((await page.getByRole('checkbox', { name: t, exact: true }).count()) > 0)
          visibleAfter.push(t);
      }
      check('архив: кейсы скрылись из таблицы', visibleAfter.length === 0, visibleAfter.join(', '));
      check('архив: неотмеченные не тронуты', same());

      await showArchive(true);
      await wait(600);
      const restore = await apply(PICKED, 'restore');
      alpha = read('alpha');
      check(
        'восстановление: touched = 3',
        restore.status === 200 && restore.touched === 3,
        JSON.stringify(restore),
      );
      check(
        'восстановление: признак архива снят',
        PICKED.every((t) => !byTitle(alpha, t)[0]?.archived),
      );
      const strip = ({ archived: _archived, updatedAt: _updatedAt, ...rest }) => rest;
      check(
        'восстановление: поля кейсов целы',
        PICKED.every(
          (t, index) =>
            JSON.stringify(strip(byTitle(alpha, t)[0] ?? {})) ===
            JSON.stringify(strip(beforeArchive[index] ?? {})),
        ),
      );
      await showArchive(false);
      await wait(600);
      let back = 0;
      for (const t of PICKED)
        back += await page.getByRole('checkbox', { name: t, exact: true }).count();
      check('восстановление: кейсы вернулись в таблицу без архива', back === 3, `видно: ${back}`);
      check('восстановление: неотмеченные не тронуты', same());
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
