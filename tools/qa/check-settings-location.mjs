/**
 * Кейс settings-models-002: панель честно называет, откуда читает
 * конфигурацию, — `/api/location` отдаёт каталог, правило выбора и список
 * недостающего, а «Настройки → Доступ → Каталог .claude» показывает тот же путь
 * и то же правило.
 *
 * Стенд одноразовый и запущен с CLAUDE_CONFIG_DIR = временный каталог, поэтому
 * правильный ответ известен заранее: путь — этот каталог, правило — «из
 * переменной окружения». Сверка UI с API без этой третьей точки сошлась бы и
 * тогда, когда оба называют чужой каталог.
 *
 * Запуск: `node tools/qa/check-settings-location.mjs` (стенд поднимается сам).
 */
import { chromium } from 'playwright';
import { runOnStand, wait } from './throwaway-stand.mjs';

const same = (a, b) =>
  String(a)
    .replace(/[\\/]+$/, '')
    .toLowerCase() ===
  String(b)
    .replace(/[\\/]+$/, '')
    .toLowerCase();

await runOnStand({ label: 'settings-location' }, async (stand, check) => {
  const { status, body } = await stand.api('/location');
  console.log(
    `  /api/location: root ${body?.paths?.root}, source ${body?.source}, missing ${JSON.stringify(body?.missing)}`,
  );
  check('API отвечает 200', status === 200, String(status));
  check(
    'API: каталог = CLAUDE_CONFIG_DIR стенда',
    same(body?.paths?.root, stand.cfg),
    `${body?.paths?.root} ≠ ${stand.cfg}`,
  );
  check('API: правило выбора названо — env', body?.source === 'env', String(body?.source));
  check(
    'API: список недостающего есть (массив)',
    Array.isArray(body?.missing),
    JSON.stringify(body?.missing),
  );

  const browser = await chromium.launch();
  try {
    const page = await stand.newPage(browser, { height: 1000 });
    await page.goto(`${stand.webUrl}/settings?tab=access`, { waitUntil: 'domcontentloaded' });
    const field = page.getByRole('textbox', { name: 'Каталог .claude' });
    await field.waitFor({ timeout: 30_000 });
    await wait(500);
    const shown = (await field.inputValue()) || (await field.getAttribute('placeholder'));
    console.log(`  «Настройки»: ${shown}`);
    check(
      'UI: путь тот же, что в API',
      same(shown, body?.paths?.root),
      `${shown} ≠ ${body?.paths?.root}`,
    );
    const card = page
      .locator('div')
      .filter({ has: field })
      .filter({ hasText: 'Каталог .claude' })
      .last();
    check(
      'UI: правило выбора — «из переменной окружения»',
      (await card.innerText()).includes('из переменной окружения'),
      (await card.innerText()).slice(0, 300),
    );
    check('страница без необработанных ошибок', page.errors.length === 0, page.errors.join(' | '));
  } finally {
    await browser.close();
  }
});
