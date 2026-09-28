/**
 * Кейс settings-models-003: «Настройки → Модели» показывает каталог моделей с
 * идентификаторами (`claude-…`), выбор Sonnet моделью по умолчанию сохраняется,
 * и в новом чате в выборе модели стоит Sonnet.
 *
 * Модель здесь не вызывается: кейс про то, с какой моделью чат СТАРТУЕТ, и это
 * видно в выборе модели шапки до первого сообщения. «Сохранён» — state.json
 * стенда и повторное чтение после F5, а не только значение select.
 *
 * Запуск: `node tools/qa/check-default-model.mjs` (стенд поднимается сам).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { runOnStand, wait } from './throwaway-stand.mjs';

await runOnStand({ label: 'default-model' }, async (stand, check) => {
  const stored = () =>
    JSON.parse(readFileSync(join(stand.cfg, 'agentdeck', 'state.json'), 'utf8')).settings ?? {};
  const browser = await chromium.launch();
  try {
    const page = await stand.newPage(browser, { height: 1200 });
    await page.goto(`${stand.webUrl}/settings?tab=models`, { waitUntil: 'domcontentloaded' });
    const select = page.getByLabel('Модель по умолчанию', { exact: true });
    await select.waitFor({ timeout: 30_000 });
    await wait(1500);
    const main = await page.locator('main').innerText();
    const ids = [...new Set(main.match(/\bclaude-[a-z0-9-]+/g) ?? [])];
    console.log(`  идентификаторов в каталоге: ${ids.length} (${ids.slice(0, 4).join(', ')}…)`);
    check('каталог моделей с идентификаторами claude-…', ids.length >= 3, ids.join(', '));

    await select.selectOption({ label: 'Sonnet' });
    await wait(1000);
    const saved = stored().chatModel;
    check(
      'выбор сохранён в state.json',
      typeof saved === 'string' && /sonnet/i.test(saved),
      String(saved),
    );
    await page.reload({ waitUntil: 'domcontentloaded' });
    await select.waitFor({ timeout: 30_000 });
    await wait(800);
    const after = await select.evaluate((node) => node.selectedOptions[0]?.textContent ?? '');
    check('после F5 в настройках стоит Sonnet', /Sonnet/.test(after), after);

    // Новый чат.
    await page.goto(`${stand.webUrl}/chat`, { waitUntil: 'domcontentloaded' });
    await wait(1500);
    const fresh = page.getByRole('button', { name: /^Новый (чат|разговор)/ }).first();
    if ((await fresh.count()) > 0) {
      await fresh.click();
      await wait(1000);
    }
    // Стенд без `claude` в PATH: чат открывает поверх окно «CLI не найден», и
    // остальная страница для дерева доступности скрыта. Выбор модели от этого не
    // меняется — берём его по разметке, а окно называем в выводе.
    const blocking = page.getByRole('dialog');
    if ((await blocking.count()) > 0) {
      console.log(
        `  поверх чата окно: ${(await blocking.first().innerText()).replace(/\s+/g, ' ').slice(0, 160)}`,
      );
    }
    const picker = page.locator('select[aria-label="Модель"]').first();
    await picker.waitFor({ timeout: 30_000 }).catch(() => undefined);
    const shown =
      (await picker.count()) > 0
        ? await picker.evaluate((node) => node.selectedOptions[0]?.textContent ?? '')
        : '';
    console.log(`  выбор модели нового чата: «${shown}»`);
    check(
      'новый чат: в выборе модели Sonnet',
      /Sonnet/.test(shown),
      shown || 'выбора модели на странице нет',
    );
    check('страница без необработанных ошибок', page.errors.length === 0, page.errors.join(' | '));
  } finally {
    await browser.close();
  }
});
