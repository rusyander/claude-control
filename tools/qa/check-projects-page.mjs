/**
 * Кейс projects-copies-005: страница проекта — чтение, правка и границы правки.
 *
 * Что доказывается на настоящем пути (панель, фронт, диск одноразового стенда):
 *   - вкладка «Инструкции» открывается документом для чтения: разметка свёрстана,
 *     редактора нет, пометка «правится здесь» и путь к файлу на месте;
 *   - на вкладках — счётчики того, что лежит на диске (MCP, права, «Из проекта»);
 *   - «Править» → текст → «Сохранить»: на диске ровно новый текст; несохранённая
 *     правка переживает переход на другую вкладку и помечена «не сохранено»;
 *   - Ctrl+S сохраняет так же; «Отменить правки» возвращает текст с диска;
 *   - «Из проекта» помечена «только чтение», и у неё нет ни одного элемента
 *     правки — ни поля, ни переключателя, ни кнопки, кроме раскрытия текста.
 *
 * Проект засеян прямо на диск одноразового дома: CLAUDE.md, .mcp.json с одним
 * сервером, .claude/settings.json с двумя правами и хуком, скилл и файл правил.
 *
 * Запуск: `node tools/qa/check-projects-page.mjs` (стенд поднимается сам).
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { runOnStand, wait } from './throwaway-stand.mjs';

const FOLDER = 'shop-page';
// Файл кончается переводом строки: Ctrl+End ставит курсор на пустую последнюю
// строку, и набор не продолжает список разметки.
const CONTENT = '# Витрина QA\n\nОтвечай по-русски.\n\n## Проверки\n\n- pnpm test\n';
const ADDED = 'QA line: проба сохранения';
const ADDED_KEYS = ' + Ctrl+S';

/** Ждать, пока файл на диске станет нужным; вернуть то, что там в итоге лежит. */
async function diskBecomes(file, expected, timeoutMs = 10_000) {
  const until = Date.now() + timeoutMs;
  let text = readFileSync(file, 'utf8');
  while (text !== expected && Date.now() < until) {
    await wait(200);
    text = readFileSync(file, 'utf8');
  }
  return text;
}

await runOnStand(
  {
    label: 'projects-page',
    seed: ({ home }) => {
      const dir = join(home, FOLDER);
      mkdirSync(join(dir, '.claude', 'skills', 'qa-notes'), { recursive: true });
      mkdirSync(join(dir, '.claude', 'rules'), { recursive: true });
      writeFileSync(join(dir, 'CLAUDE.md'), CONTENT, 'utf8');
      writeFileSync(
        join(dir, '.mcp.json'),
        `${JSON.stringify({ mcpServers: { 'qa-mock': { command: 'node', args: ['mock.mjs'] } } }, null, 2)}\n`,
        'utf8',
      );
      writeFileSync(
        join(dir, '.claude', 'settings.json'),
        `${JSON.stringify(
          {
            permissions: { allow: ['Bash(pnpm test:*)'], deny: ['Edit(migrations/**)'] },
            hooks: {
              PreToolUse: [
                {
                  matcher: 'Bash',
                  hooks: [{ type: 'command', command: 'node .claude/hooks/guard.mjs' }],
                },
              ],
            },
          },
          null,
          2,
        )}\n`,
        'utf8',
      );
      writeFileSync(
        join(dir, '.claude', 'skills', 'qa-notes', 'SKILL.md'),
        '---\nname: qa-notes\ndescription: Заметки прогона.\n---\n\nТело скилла.\n',
        'utf8',
      );
      writeFileSync(
        join(dir, '.claude', 'rules', 'frontend.md'),
        '# QA правило\n\nТекст правила.\n',
        'utf8',
      );
    },
  },
  async (stand, check) => {
    const dir = join(stand.home, FOLDER);
    const file = join(dir, 'CLAUDE.md');
    const added = await stand.api('/projects', { method: 'POST', body: { path: dir } });
    check('проект заведён в реестр стенда', added.status === 200, added.text.slice(0, 200));

    const browser = await chromium.launch();
    try {
      const page = await stand.newPage(browser, { height: 1000 });
      await page.goto(`${stand.webUrl}/projects`, { waitUntil: 'domcontentloaded' });
      await page
        .getByRole('navigation', { name: 'Добавленные проекты' })
        .getByRole('button', { name: new RegExp(FOLDER) })
        .click({ timeout: 30_000 });

      // ── Чтение ────────────────────────────────────────────────────────────
      const instructionsTab = page.getByRole('tab', { name: /^Инструкции/ });
      await instructionsTab.waitFor({ timeout: 30_000 });
      const preview = page.getByRole('article', { name: 'Содержимое CLAUDE.md' });
      await preview.waitFor({ timeout: 30_000 });
      check(
        'вкладка «Инструкции» открыта первой',
        (await instructionsTab.getAttribute('aria-selected')) === 'true',
      );
      check(
        'разметка свёрстана: заголовок файла — заголовок, а не текст с решёткой',
        (await preview.getByRole('heading', { name: 'Витрина QA' }).count()) === 1,
      );
      const editor = page.getByRole('textbox', { name: 'Текст CLAUDE.md' });
      check('в режиме чтения редактора нет', (await editor.count()) === 0);
      const main = await page.locator('main').innerText();
      check('пометка «правится здесь»', main.includes('правится здесь'));
      check('показан путь к файлу', main.includes(file) || main.includes(file.replace(/\\/g, '/')));
      check(
        'кнопок сохранения до правки нет',
        (await page.getByRole('button', { name: 'Сохранить', exact: true }).count()) === 0,
      );

      // ── Счётчики вкладок ──────────────────────────────────────────────────
      const tabName = async (pattern) =>
        (await page.getByRole('tab', { name: pattern }).first().textContent())?.trim() ?? '';
      const mcpName = await tabName(/^MCP-серверы/);
      check('«MCP-серверы» считает 1 сервер', /MCP-серверы\D*1$/.test(mcpName), mcpName);
      const permsName = await tabName(/^Права/);
      check('«Права» считает 2 правила', /Права\D*2$/.test(permsName), permsName);
      const localName = await tabName(/^Из проекта/);
      // За числом идёт расшифровка для чтения с экрана — она и называет состав.
      check(
        '«Из проекта» считает 3 записи и называет состав',
        /^Из проекта\D*3\b/.test(localName) &&
          localName.includes('скиллов: 1, хуков: 1, правил: 1'),
        localName,
      );

      // ── Правка и сохранение кнопкой ──────────────────────────────────────
      await page.getByRole('button', { name: 'Править', exact: true }).click();
      await editor.waitFor({ timeout: 10_000 });
      await wait(300);
      // Фокус ставит сам редактор: снаружи он попадал в экземпляр, который
      // строгий режим React пересоздаёт, и уходил на body — печать шла в никуда.
      check(
        '«Править» ставит курсор в текст',
        await page.evaluate(
          () => document.activeElement?.getAttribute('aria-label') === 'Текст CLAUDE.md',
        ),
        await page.evaluate(() => document.activeElement?.tagName ?? 'нет'),
      );
      await editor.click();
      await page.keyboard.press('Control+End');
      await page.keyboard.type(ADDED);
      await wait(300);
      check(
        'несохранённая правка помечена на вкладке',
        /не сохранено/.test((await instructionsTab.textContent()) ?? ''),
      );
      check('до сохранения диск не тронут', readFileSync(file, 'utf8') === CONTENT);

      // Черновик живёт выше вкладки: уход на «Права» и назад его не теряет.
      await page.getByRole('tab', { name: /^Права/ }).click();
      await wait(400);
      await instructionsTab.click();
      await preview.waitFor({ timeout: 10_000 });
      check(
        'черновик пережил переход по вкладкам',
        ((await preview.textContent()) ?? '').includes(ADDED),
      );

      await page.getByRole('button', { name: 'Сохранить', exact: true }).click();
      const saved = await diskBecomes(file, CONTENT + ADDED);
      check(
        '«Сохранить»: на диске ровно новый текст',
        saved === CONTENT + ADDED,
        JSON.stringify(saved),
      );
      await wait(500);
      check(
        'после сохранения пометки «не сохранено» нет',
        !/не сохранено/.test((await instructionsTab.textContent()) ?? ''),
      );

      // ── Ctrl+S ────────────────────────────────────────────────────────────
      await page.getByRole('button', { name: 'Править', exact: true }).click();
      await editor.waitFor({ timeout: 10_000 });
      await editor.click();
      await page.keyboard.press('Control+End');
      await page.keyboard.type(ADDED_KEYS);
      await page.keyboard.press('Control+s');
      const savedKeys = await diskBecomes(file, CONTENT + ADDED + ADDED_KEYS);
      check(
        'Ctrl+S сохраняет так же',
        savedKeys === CONTENT + ADDED + ADDED_KEYS,
        JSON.stringify(savedKeys),
      );

      // ── Отмена правки ─────────────────────────────────────────────────────
      await wait(500);
      await page.keyboard.press('Control+End');
      await page.keyboard.type(' junk');
      await wait(300);
      await page.getByRole('button', { name: 'Отменить правки', exact: true }).click();
      await wait(500);
      const shown = await editor
        .locator('.cm-line')
        .evaluateAll((lines) => lines.map((line) => line.textContent ?? '').join('\n'));
      check(
        '«Отменить правки» вернул текст с диска',
        shown === CONTENT + ADDED + ADDED_KEYS,
        JSON.stringify(shown),
      );
      check(
        'отмена не писала на диск',
        readFileSync(file, 'utf8') === CONTENT + ADDED + ADDED_KEYS,
      );

      // ── MCP правится здесь ────────────────────────────────────────────────
      await page.getByRole('tab', { name: /^MCP-серверы/ }).click();
      const panel = page.getByRole('tabpanel');
      await panel.getByText('qa-mock').first().waitFor({ timeout: 10_000 });
      check(
        '«MCP-серверы»: пометка «правится здесь» и «Добавить сервер»',
        (await panel.getByText('правится здесь', { exact: true }).count()) === 1 &&
          (await panel.getByRole('button', { name: 'Добавить сервер' }).count()) === 1,
      );

      // ── «Из проекта» — только чтение ─────────────────────────────────────
      await page.getByRole('tab', { name: /^Из проекта/ }).click();
      await panel.getByText('qa-notes', { exact: true }).waitFor({ timeout: 10_000 });
      check(
        '«Из проекта»: пометка «только чтение»',
        (await panel.getByText('только чтение', { exact: true }).count()) === 1 &&
          (await panel.getByText('правится здесь', { exact: true }).count()) === 0,
      );
      const inputs = await panel
        .locator(
          'input, textarea, select, [contenteditable="true"], [role="switch"], [role="checkbox"]',
        )
        .count();
      check('«Из проекта»: ни одного поля и переключателя', inputs === 0, `элементов: ${inputs}`);
      const buttons = await panel
        .getByRole('button')
        .evaluateAll((nodes) =>
          nodes.map((node) => node.getAttribute('aria-label') ?? node.textContent?.trim() ?? ''),
        );
      const edits = buttons.filter((name) => !/^(Показать текст|Скрыть текст)/.test(name));
      check(
        '«Из проекта»: из кнопок только раскрытие текста',
        edits.length === 0,
        `лишние кнопки: ${JSON.stringify(edits)}`,
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
