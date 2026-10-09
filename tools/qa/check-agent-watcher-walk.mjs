/**
 * Агент панели включает наблюдатель — открытая страница «Наблюдатель» видит это сразу.
 *
 * До правки 09.10.2026 действия `watcher_status`/`set_watcher` числились в разделе
 * `settings`: кадр `agent-decided` перечитывал ключ настроек, а страница наблюдателя
 * читает свой (`watcher`) и узнавала о включении только на следующем опросе —
 * в выключенном состоянии это 15 с. Теперь у действий свой раздел `watcher`.
 *
 * Подменена только модель — фальшивый `claude` (`fake-cli-panel-agent-watcher.mjs`)
 * первым в PATH одноразовой панели. Путь настоящий: окно агента → процесс CLI с
 * `--mcp-config` панели → переходник `tools/mcp/panel.mjs` → `set_watcher` →
 * карточка → «Одобрить» в окне → кадр `agent-decided` → перечитывание страницы.
 *
 * Окно ожидания (5 с) меньше опроса выключенной страницы (15 с): зелёный результат
 * даёт только перечитывание по кадру. Выключение то же самое не различает —
 * включённая страница сама опрашивает раз в 3 с, — оно проверяет лишь исход.
 *
 * Запуск: `node tools/qa/check-agent-watcher-walk.mjs`
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { REPO, runOnStand, wait } from './throwaway-stand.mjs';
import { FAKE_PANEL_AGENT_WATCHER_CLI_SOURCE } from './fake-cli-panel-agent-watcher.mjs';
import { dismissAccess } from './chat-walk.mjs';

const SHOTS = join(REPO, '.agent', 'screenshots', 'before-after', 'agent-watcher-section');
mkdirSync(SHOTS, { recursive: true });

/** Меньше опроса выключенной страницы (POLL_OFF_MS = 15 с в WatcherApi.ts). */
const FRESH_MS = 5_000;

await runOnStand(
  { label: 'agent-watcher-walk', fakeCli: { claude: FAKE_PANEL_AGENT_WATCHER_CLI_SOURCE } },
  async (stand, check) => {
    const browser = await chromium.launch();
    try {
      const page = await stand.newPage(browser, { height: 1000 });
      await page.goto(`${stand.webUrl}/watcher`, { waitUntil: 'domcontentloaded' });
      await dismissAccess(page);
      const start = page.locator('[data-watcher-start]');
      const stop = page.locator('[data-watcher-stop]');
      await start.waitFor({ timeout: 60_000 });
      check('наблюдатель стенда выключен', await start.isVisible());

      const trigger = page.locator('[data-panel-agent-trigger]');
      const win = page.locator('[data-panel-agent-window]');
      const input = win.locator('[data-agent-input]');
      await trigger.click();
      await input.waitFor();

      /** Ответ планового опроса страницы — после него до следующего ~15 с. */
      const poll = () =>
        page.waitForResponse(
          (response) =>
            response.request().method() === 'GET' &&
            new URL(response.url()).pathname === '/api/watcher',
          { timeout: 20_000 },
        );

      const approve = async (text) => {
        await input.fill(text);
        await input.press('Enter');
        const button = win.locator('[data-agent-decision="approve"]').first();
        await button.waitFor({ timeout: 60_000 });
        // Одобрение сразу после опроса: иначе плановый опрос мог попасть в окно
        // ожидания и выдать зелёный результат без перечитывания по кадру.
        await Promise.all([poll(), wait(700)]); // кнопки карточки оживают через полсекунды
        await button.click();
        return Date.now();
      };

      const approvedAt = await approve('Включи наблюдатель');
      const fresh = await stop
        .waitFor({ timeout: FRESH_MS })
        .then(() => true)
        .catch(() => false);
      check(
        `страница показала «включён» за ${FRESH_MS / 1000} с, не дожидаясь опроса`,
        fresh,
        fresh ? `${Date.now() - approvedAt} мс` : 'кнопка «Остановить» не появилась',
      );
      const status = await stand.api('/watcher');
      check(
        'сервер: наблюдатель включён',
        status.body?.enabled === true,
        JSON.stringify(status.body),
      );
      await page.screenshot({ path: join(SHOTS, 'watcher-on_AFTER.png') });

      await approve('Выключи наблюдатель');
      const off = await start
        .waitFor({ timeout: 15_000 })
        .then(() => true)
        .catch(() => false);
      check('выключение агентом дошло до страницы', off);
      check('страница без ошибок', page.errors.length === 0, page.errors.join(' | '));
    } finally {
      await browser.close();
    }
  },
);
