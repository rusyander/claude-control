/**
 * Кейс access-integrations-003: stdio MCP-сервер добавляется формой,
 * «Проверить» честно отражает реальность (живой сервер — «Отвечает» и его
 * инструменты, заведомо неверная команда — «Не отвечает» с причиной), удаление
 * убирает сервер из списка и из конфига.
 *
 * Сервер настоящий: `tools/qa/mcp-marker.mjs` — процесс по stdio с одним
 * инструментом `marker`. Панель запускает его сама, как запустит Claude Code;
 * ничего не подменяется. Конфиг — `.claude.json` временного каталога
 * (путь берётся из /api/location стенда, а не угадывается).
 *
 * Запуск: `node tools/qa/check-mcp-stdio.mjs` (стенд поднимается сам).
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { REPO, runOnStand, wait } from './throwaway-stand.mjs';

const NAME = 'probe-marker';
const MARKER = join(REPO, 'tools', 'qa', 'mcp-marker.mjs').replace(/\\/g, '/');
const BROKEN = 'agentdeck-no-such-binary-xyz';

await runOnStand({ label: 'mcp-stdio' }, async (stand, check) => {
  const location = await stand.api('/location');
  const configPath = location.body?.paths?.mcpConfig;
  check(
    'стенд назвал файл конфига MCP внутри временного дома',
    Boolean(configPath) && configPath.startsWith(stand.home),
    String(configPath),
  );
  const servers = () =>
    existsSync(configPath) ? (JSON.parse(readFileSync(configPath, 'utf8')).mcpServers ?? {}) : {};

  const browser = await chromium.launch();
  try {
    const page = await stand.newPage(browser, { height: 1300 });
    await page.goto(`${stand.webUrl}/mcp`, { waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: 'Добавить сервер' }).first().click();
    const form = page.getByRole('dialog').filter({ has: page.getByLabel('Имя сервера') });
    await form.waitFor({ timeout: 30_000 });
    await form.getByLabel('Имя сервера').fill(NAME);
    await form.getByLabel('Транспорт').selectOption('stdio');
    await form.getByLabel('Команда запуска').fill('node');
    await form.getByLabel('Аргументы').fill(MARKER);
    await form.getByRole('button', { name: 'Сохранить' }).click();
    await form.waitFor({ state: 'hidden', timeout: 10_000 }).catch(() => undefined);
    await wait(600);

    const entry = servers()[NAME];
    check(
      'конфиг: сервер записан как stdio node + путь маркера',
      entry?.command === 'node' && JSON.stringify(entry?.args) === JSON.stringify([MARKER]),
      JSON.stringify(entry),
    );
    const card = page.locator(`[data-agent-anchor="${NAME}"]`);
    check('сервер в списке', (await card.count()) === 1);

    // Живой сервер: «Отвечает: 1 инструментов» и в списке инструментов marker.
    await card.getByRole('button', { name: 'Проверить', exact: true }).click();
    await card
      .getByText(/^Отвечает/)
      .waitFor({ timeout: 60_000 })
      .catch(() => undefined);
    const okText = await card.innerText();
    check(
      'живой: статус «Отвечает» с числом инструментов 1',
      /Отвечает: 1 инструментов/.test(okText),
      okText.replace(/\s+/g, ' '),
    );
    await card.getByRole('button', { name: 'Инструменты', exact: true }).click();
    const tools = page.getByRole('dialog').last();
    await tools
      .getByText('marker')
      .first()
      .waitFor({ timeout: 60_000 })
      .catch(() => undefined);
    const toolsText = await tools.innerText();
    check(
      'живой: в списке инструментов есть marker',
      /\bmarker\b/.test(toolsText),
      toolsText.replace(/\s+/g, ' ').slice(0, 300),
    );
    await page.keyboard.press('Escape');
    await tools.waitFor({ state: 'hidden', timeout: 5000 }).catch(() => undefined);

    // Неверная команда → «Не отвечает» и текст причины.
    await card.getByRole('button', { name: `Редактировать: ${NAME}` }).click();
    await form.waitFor();
    await form.getByLabel('Команда запуска').fill(BROKEN);
    await form.getByRole('button', { name: 'Сохранить' }).click();
    await form.waitFor({ state: 'hidden', timeout: 10_000 }).catch(() => undefined);
    await wait(600);
    check(
      'конфиг: команда заменена на неверную',
      servers()[NAME]?.command === BROKEN,
      JSON.stringify(servers()[NAME]),
    );
    await card.getByRole('button', { name: 'Проверить', exact: true }).click();
    await card
      .getByText('Не отвечает')
      .waitFor({ timeout: 60_000 })
      .catch(() => undefined);
    const badText = await card.innerText();
    console.log(`  карточка после неверной команды: ${badText.replace(/\s+/g, ' ').slice(0, 300)}`);
    check(
      'неверная: статус «Не отвечает»',
      badText.includes('Не отвечает'),
      badText.replace(/\s+/g, ' '),
    );
    check(
      'неверная: причина названа — строка ошибки про саму неверную команду',
      badText
        .split('\n')
        .some(
          (line) =>
            /(error|ошибк|не является|not recognized|not found|ENOENT|не найден|не удалось запустить)/i.test(
              line,
            ) && line.includes(BROKEN),
        ),
      badText.replace(/\s+/g, ' '),
    );
    check('неверная: прежнего «Отвечает» не осталось', !/Отвечает:/.test(badText));

    // Удаление.
    await card.getByRole('button', { name: `Удалить: ${NAME}` }).click();
    const confirm = page.getByRole('dialog').last();
    await confirm.waitFor();
    const typed = confirm.getByRole('textbox');
    if ((await typed.count()) > 0) await typed.first().fill(NAME);
    await confirm.getByRole('button', { name: 'Удалить' }).click();
    await confirm.waitFor({ state: 'hidden', timeout: 10_000 }).catch(() => undefined);
    await wait(600);
    check(
      'удаление: в конфиге сервера нет',
      servers()[NAME] === undefined,
      JSON.stringify(servers()),
    );
    check('удаление: в списке сервера нет', (await card.count()) === 0);
    check('страница без необработанных ошибок', page.errors.length === 0, page.errors.join(' | '));
  } finally {
    await browser.close();
  }
});
