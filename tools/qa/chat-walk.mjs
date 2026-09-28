/**
 * Шаги чата одноразового стенда для проверок, которым нужен ХОД через экран:
 * вкладка проекта, отправка из поля, выбор группы в меню «Настройки чата» и
 * ожидание хода у фальшивого CLI (`fake-cli-append.mjs`).
 *
 * Меню группы есть только у разговора, который уже существует (у черновика
 * `chatId` ещё нет), — поэтому первый ход отправляется до выбора группы.
 */
import { readTurns } from './fake-cli-append.mjs';
import { wait } from './throwaway-stand.mjs';

/** Страница чата с одной вкладкой проекта `dir`, окно «нужен доступ» закрыто. */
export async function openProjectChat(stand, browser, dir, name = 'project') {
  const page = await stand.newPage(browser, { height: 1000 });
  await page.goto(`${stand.webUrl}/`, { waitUntil: 'domcontentloaded' });
  await page.evaluate(
    ({ dir: path, name: label }) => {
      const tabId = path.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
      localStorage.setItem(
        'agentdeck:workspace',
        JSON.stringify({
          projectTabs: [{ id: tabId, path, name: label }],
          activeTabId: tabId,
          views: {},
        }),
      );
    },
    { dir, name },
  );
  await page.goto(`${stand.webUrl}/chat`, { waitUntil: 'domcontentloaded' });
  await page.locator('textarea[data-chat-input]').waitFor({ timeout: 90_000 });
  await dismissAccess(page);
  return page;
}

/** Окно «нужен доступ» (у стенда нет входа в CLI) закрывает страницу — закрыть его. */
export async function dismissAccess(page) {
  const blocking = page.getByRole('dialog').filter({ hasText: 'нужен доступ' });
  await blocking
    .first()
    .waitFor({ timeout: 10_000 })
    .catch(() => undefined);
  if ((await blocking.count()) > 0) {
    await blocking.first().getByRole('button', { name: 'Закрыть' }).first().click();
    await blocking
      .first()
      .waitFor({ state: 'hidden', timeout: 5000 })
      .catch(() => undefined);
  }
}

/** Отправить текст из поля и дождаться хода с ним у фальшивого CLI; ход или `undefined`. */
export async function sendAndWait(page, stand, text, seconds = 30) {
  const input = page.locator('textarea[data-chat-input]');
  await input.fill(text);
  await input.press('Enter');
  for (let i = 0; i < seconds * 4; i += 1) {
    const turn = readTurns(stand.read, stand.bin).find((one) => one.prompt.includes(text));
    if (turn) {
      // Ход записан — дать панели дописать ответ, чтобы поле снова приняло ввод.
      await wait(1200);
      return turn;
    }
    await wait(250);
  }
  if (process.env.SHOTS) {
    await page.screenshot({ path: `${process.env.SHOTS}/send-missed.png` }).catch(() => undefined);
  }
  console.log(
    `  ~ ход «${text}» не дошёл; ходов у CLI: ${readTurns(stand.read, stand.bin).length}; поле: «${await input.inputValue().catch(() => '?')}»`,
  );
  return undefined;
}

/**
 * Открыть меню «Настройки чата» и вернуть список «Группа»: подписи вариантов
 * и выбрать вариант, чья подпись совпала с `pick` (строка или RegExp).
 */
export async function chatGroupMenu(page, pick) {
  await page.getByRole('button', { name: 'Настройки чата' }).first().click();
  const select = page.getByRole('combobox', { name: 'Группа' });
  await select.waitFor({ timeout: 10_000 });
  const labels = (await select.locator('option').allTextContents()).map((one) => one.trim());
  const current = await select.evaluate((node) =>
    node instanceof HTMLSelectElement ? (node.selectedOptions[0]?.textContent ?? '').trim() : '',
  );
  if (pick !== undefined) {
    const option = select.locator('option').filter({ hasText: pick }).first();
    const value = await option.getAttribute('value');
    await select.selectOption(value ?? '');
    await wait(800);
  }
  await page.keyboard.press('Escape');
  await wait(300);
  return { labels, current };
}
