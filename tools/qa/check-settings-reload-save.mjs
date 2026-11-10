/**
 * Правка настроек переживает F5 сразу после клика.
 *
 * Первый PATCH настроек судят ворота «только человек» (`human-only.ts`): они читают
 * таблицы ОС, на нагруженной машине до ~3 с. Перезагрузка в это окно закрывала
 * соединение, ворота уже не находили его владельца, и правка, видная на экране,
 * на сервер не доходила. Теперь PATCH уходит с `keepalive` (`patchSettings.ts`):
 * браузер доводит его и после ухода со страницы, а новая страница узнаёт итог из
 * потока событий.
 *
 * Своя панель и свой фронт над временным домом (`throwaway-stand.mjs`): проверка
 * пишет настройки, настоящий стенд не трогается. Выход 1 — правка потерялась.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { runOnStand, wait } from './throwaway-stand.mjs';

/** Ждать условие до `ms`: правка доходит до файла, когда ворота её пропустят. */
const until = async (probe, ms) => {
  for (let left = ms; left > 0; left -= 250) {
    if (await probe()) return true;
    await wait(250);
  }
  return Boolean(await probe());
};

await runOnStand({ label: 'settings-reload-save' }, async (stand, check) => {
  const stored = () =>
    JSON.parse(readFileSync(join(stand.cfg, 'agentdeck', 'state.json'), 'utf8')).settings ?? {};
  const browser = await chromium.launch();
  try {
    const page = await stand.newPage(browser, { height: 1000 });
    await page.goto(`${stand.webUrl}/settings`, { waitUntil: 'domcontentloaded' });
    const dark = page.getByRole('button', { name: 'Тёмная', exact: true });
    await dark.waitFor({ timeout: 30_000 });
    const before = await page.evaluate(() => document.documentElement.dataset.theme);
    check('до правки тема светлая', before === 'light', String(before));

    // Первый PATCH стенда — ворота ещё холодные. F5 сразу, ответа не ждём.
    const sent = page.waitForRequest(
      (r) => r.url().includes('/api/settings') && r.method() === 'PATCH',
      { timeout: 10_000 },
    );
    await dark.click();
    await sent;
    await page.reload({ waitUntil: 'domcontentloaded' });

    const reached = await until(() => stored().theme === 'dark', 20_000);
    check('правка дошла до state.json после F5', reached, JSON.stringify(stored().theme));

    const shown = await until(
      () => page.evaluate(() => document.documentElement.dataset.theme === 'dark'),
      20_000,
    );
    check(
      'перезагруженная страница показывает сохранённую тему',
      shown,
      String(await page.evaluate(() => document.documentElement.dataset.theme)),
    );
  } finally {
    await browser.close();
  }
});
