/**
 * Кейс projects-copies-004: удаление проекта из реестра — это удаление ссылки:
 * проекта нет ни в списке, ни в селекте «Проект» раздела «Тестирование», а
 * папка на диске цела до байта, включая `.agent/tests`.
 *
 * Два проекта заводятся через API стенда (второй — чтобы селект после удаления
 * остался на экране и было видно, что пропал именно удалённый). Снимок папки
 * снимается ПОСЛЕ добавления: добавление само кладёт в проект заготовку e2e, и
 * удаление сравнивается с тем, что лежало перед ним, а не до панели.
 *
 * «Удалить» стоит в шапке выбранного проекта, а не у каждой строки реестра —
 * поэтому проект сначала выбирается.
 *
 * Запуск: `node tools/qa/check-project-remove.mjs` (стенд поднимается сам).
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { chromium } from 'playwright';
import { runOnStand, wait } from './throwaway-stand.mjs';

const GONE = 'remove-me';
const KEPT = 'keep-me';

/** Все файлы папки с содержимым — снимок для побайтного сравнения. */
const snapshot = (dir) =>
  Object.fromEntries(
    readdirSync(dir, { withFileTypes: true, recursive: true })
      .filter((entry) => entry.isFile())
      .map((entry) => {
        const path = join(entry.parentPath ?? entry.path, entry.name);
        return [relative(dir, path), readFileSync(path).toString('base64')];
      })
      .sort(([a], [b]) => a.localeCompare(b)),
  );

await runOnStand(
  {
    label: 'project-remove',
    seed: ({ home }) => {
      for (const name of [GONE, KEPT]) {
        mkdirSync(join(home, name, '.agent', 'tests'), { recursive: true });
        writeFileSync(join(home, name, 'AGENTS.md'), `# ${name}\n`, 'utf8');
      }
      writeFileSync(
        join(home, GONE, '.agent', 'tests', 'probe.tests.json'),
        `${JSON.stringify({ cases: [{ id: 'probe-001', title: 'Проба' }] }, null, 2)}\n`,
        'utf8',
      );
      writeFileSync(join(home, GONE, 'notes.txt'), 'не трогать\n', 'utf8');
    },
  },
  async (stand, check) => {
    const gone = join(stand.home, GONE);
    for (const name of [GONE, KEPT]) {
      const res = await stand.api('/projects', {
        method: 'POST',
        body: { path: join(stand.home, name) },
      });
      check(`проект ${name} заведён`, res.status === 200, res.text.slice(0, 200));
    }
    const before = snapshot(gone);
    check(
      'в снимке есть .agent/tests',
      Object.keys(before).some((path) => path.includes(join('.agent', 'tests'))),
    );

    const browser = await chromium.launch();
    try {
      const page = await stand.newPage(browser, { height: 1100 });
      await page.goto(`${stand.webUrl}/projects`, { waitUntil: 'domcontentloaded' });
      await page
        .getByRole('navigation', { name: 'Добавленные проекты' })
        .getByRole('button', { name: new RegExp(GONE) })
        .click({ timeout: 30_000 });
      await page.getByRole('button', { name: `Удалить: ${GONE}` }).waitFor({ timeout: 30_000 });
      await page.getByRole('button', { name: `Удалить: ${GONE}` }).click();
      const confirm = page.getByRole('dialog').last();
      await confirm.waitFor();
      const typed = confirm.getByRole('textbox');
      if ((await typed.count()) > 0) await typed.first().fill(GONE);
      await confirm.getByRole('button', { name: 'Удалить' }).click();
      await confirm.waitFor({ state: 'hidden', timeout: 10_000 }).catch(() => undefined);
      await wait(800);

      const registry = (await stand.api('/projects')).body ?? [];
      check(
        'реестр: проекта нет',
        registry.every((item) => !item.path.endsWith(GONE)),
        JSON.stringify(registry),
      );
      check(
        'реестр: второй проект на месте',
        registry.some((item) => item.path.endsWith(KEPT)),
      );
      check(
        'список раздела: проекта нет',
        (await page.getByRole('button', { name: new RegExp(GONE) }).count()) === 0,
      );

      await page.goto(`${stand.webUrl}/tests`, { waitUntil: 'domcontentloaded' });
      const select = page.getByLabel('Проект', { exact: true });
      await select.waitFor({ timeout: 30_000 });
      const options = await select.locator('option').allInnerTexts();
      check(
        '«Тестирование»: в селекте нет удалённого, есть оставшийся',
        !options.includes(GONE) && options.includes(KEPT),
        JSON.stringify(options),
      );

      const after = snapshot(gone);
      const lost = Object.keys(before).filter((path) => after[path] !== before[path]);
      const extra = Object.keys(after).filter((path) => !(path in before));
      check(
        'диск: все файлы на месте и не изменены',
        lost.length === 0,
        `изменены или пропали: ${lost.join(', ')}`,
      );
      check('диск: ничего не добавлено', extra.length === 0, extra.join(', '));
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
