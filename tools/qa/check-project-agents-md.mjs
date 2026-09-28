/**
 * Кейс projects-copies-002: в проекте без CLAUDE.md панель читает AGENTS.md и
 * говорит об этом — «Читается: AGENTS.md», путь к файлу, и число символов в
 * редакторе равно числу символов файла на диске.
 *
 * Вкладка «Инструкции» открывается документом для чтения; редактор — за
 * кнопкой «Править». Редактор — CodeMirror (contenteditable), поэтому текст
 * берётся из его строк, а не через inputValue.
 *
 * Проект засеян одним AGENTS.md с кириллицей (символы и байты у неё
 * расходятся — так видно, что считается именно текст файла). Добавляется в
 * реестр через API стенда: добавление папки — предмет другого кейса.
 *
 * Запуск: `node tools/qa/check-project-agents-md.mjs` (стенд поднимается сам).
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { runOnStand, wait } from './throwaway-stand.mjs';

const FOLDER = 'agents-only';
const CONTENT = '# Инструкции агента\n\nОтвечай по-русски, коротко.\n\n- Проба: AGENTS.md\n';

await runOnStand(
  {
    label: 'project-agents-md',
    seed: ({ home }) => {
      mkdirSync(join(home, FOLDER), { recursive: true });
      writeFileSync(join(home, FOLDER, 'AGENTS.md'), CONTENT, 'utf8');
    },
  },
  async (stand, check) => {
    const dir = join(stand.home, FOLDER);
    const file = join(dir, 'AGENTS.md');
    const added = await stand.api('/projects', { method: 'POST', body: { path: dir } });
    check('проект заведён в реестр стенда', added.status === 200, added.text.slice(0, 200));
    check('CLAUDE.md в проекте нет', !existsSync(join(dir, 'CLAUDE.md')));

    const browser = await chromium.launch();
    try {
      const page = await stand.newPage(browser, { height: 1200 });
      await page.goto(`${stand.webUrl}/projects`, { waitUntil: 'domcontentloaded' });
      await page
        .getByRole('button', { name: new RegExp(FOLDER) })
        .first()
        .click();
      await page
        .getByRole('tab', { name: /^Инструкции/ })
        .first()
        .click()
        .catch(() => undefined);
      await page.getByRole('button', { name: 'Править', exact: true }).click({ timeout: 30_000 });
      const editor = page.getByRole('textbox', { name: 'Текст AGENTS.md' });
      await editor.waitFor({ timeout: 30_000 });
      await wait(500);
      const main = await page.locator('main').innerText();

      check('надпись «Читается: AGENTS.md»', /Читается: AGENTS\.md/.test(main), main.slice(0, 800));
      const shownPath = main.includes(file) || main.includes(file.replace(/\\/g, '/'));
      check('показан путь к файлу', shownPath, `ожидался ${file}`);
      // Файл короткий — CodeMirror рисует все строки, и их текст и есть документ.
      const value = await editor
        .locator('.cm-line')
        .evaluateAll((lines) => lines.map((line) => line.textContent ?? '').join('\n'));
      check(
        'в редакторе ровно текст AGENTS.md',
        value === readFileSync(file, 'utf8'),
        JSON.stringify(value),
      );
      const chars = /Символов: (\d[\d\s]*)/.exec(main);
      const shown = chars ? Number(chars[1].replace(/\s/g, '')) : NaN;
      console.log(
        `  на экране символов: ${shown}; в файле символов ${CONTENT.length}, байт ${statSync(file).size}`,
      );
      check(
        'число символов = числу символов файла',
        shown === CONTENT.length,
        `${shown} ≠ ${CONTENT.length}`,
      );
      check('файл на диске не тронут', readFileSync(file, 'utf8') === CONTENT);
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
