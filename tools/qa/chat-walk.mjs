/**
 * Шаги чата одноразового стенда для проверок, которым нужен экран чата: вкладка
 * проекта и закрытие окна «нужен доступ» (у стенда нет входа в CLI). Ход в чат
 * Claude идёт через ядро — его проверки ведут ход сами (`check-core-chat.mjs`).
 */

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
