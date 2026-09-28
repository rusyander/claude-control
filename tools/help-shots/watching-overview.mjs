/**
 * Сценарии раздела «Обзор»: спокойный вход и тревожный.
 *
 * Делятся по входу, а не по объёму. `tour` проходят один раз — после установки,
 * когда надо понять, что панель вообще видит. `trouble` открывают в другой день
 * и по другому поводу: числа не сходятся с тем, что человек помнит о своей
 * конфигурации, и вопрос уже не «что здесь есть», а «туда ли панель смотрит».
 *
 * Оба кадра тревожного пути настоящие в том смысле, который важен: плитка
 * краснеет не потому, что её попросили, а потому что в settings.json лежит хук
 * со скриптом, которого нет на диске (`breakHook` кладёт его перед съёмкой).
 */
import { settings, location, emptyConfig, open, frame } from './watching-stubs.mjs';

export async function shootTour(browser, web, scenario) {
  // ── 01. Весь раздел: каталог, сводка изменений и плитки ──────────────────
  // Копии в стенде датированы 7–10 сентября, а «Изменения за 7 дн.» считает
  // браузер от своего «сейчас»: без переведённых часов кадр показывал 0 в
  // любой день позже 14-го. Часы переводятся только здесь: на переведённых
  // часах следующий вход на страницу оставлял `main` пустым.
  const clocked = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  try {
    await clocked.clock.install({ time: new Date('2026-09-11T09:00:00Z') });
    await clocked.clock.resume();
    await settings(clocked);
    await location(clocked);
    await open(clocked, web, '/');
    await clocked
      .getByText(/Изменения за|Changes in/)
      .first()
      .waitFor({ timeout: 30_000 });
    await clocked.waitForTimeout(800);
    await frame(scenario, clocked, '01-tiles');
  } finally {
    await clocked.close();
  }

  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  try {
    await settings(page);
    await location(page);

    // ── 02. Плитка — дверь: число сходится со списком раздела ────────────────
    await open(page, web, '/');
    await page
      .getByRole('link', { name: /Правила|Rules/ })
      .first()
      .click();
    await settled(page);
    await frame(scenario, page, '02-section');

    // ── 03. Быстрое действие ведёт сразу в форму создания ────────────────────
    await open(page, web, '/');
    await page
      .getByRole('link', { name: /Добавить|Add/ })
      .nth(1)
      .click();
    await settled(page);
    await frame(scenario, page, '03-quick-add');

    // ── 04. Сводка изменений ведёт в историю ─────────────────────────────────
    await open(page, web, '/');
    await page
      .getByRole('link', { name: /Изменения за|Changes in/ })
      .first()
      .click();
    await settled(page);
    await frame(scenario, page, '04-changes');
  } finally {
    await page.close();
  }
}

export async function shootTrouble(browser, web, scenario) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });

  try {
    await settings(page);
    // Каталог, заданный руками, и недостающий CLAUDE.md — то самое состояние, в
    // котором «панель показывает не мою конфигурацию». На исправном стенде его
    // не бывает, а объяснять его надо именно на картинке.
    // Имя файла инструкций в списке — разрешённое (П2.7): в каталоге, где нет ни
    // одного из двух, панель называет `AGENTS.md` — тот, который прочитал бы CLI.
    await location(page, {
      root: 'D:/backup/claude-2026-08',
      source: 'manual',
      missing: ['AGENTS.md', 'settings.json'],
    });

    // ── 01. Не тот каталог: бейдж называет, кто его выбрал ───────────────────
    // Счётчики в этом кадре тоже подменены нулями: симптом — «путь один, а числа
    // не оттуда», и плитки настоящего каталога опровергали бы собственную подпись.
    await emptyConfig(page);
    await open(page, web, '/');
    await frame(scenario, page, '01-wrong-dir');

    // ── 02. Красная плитка: хук ссылается на несуществующий скрипт ───────────
    await page.unroute('**/api/overview');
    await page.unroute('**/api/history');
    await page.unroute('**/api/backups');
    await location(page);
    await open(page, web, '/');
    await frame(scenario, page, '02-broken-hook');

    // ── 03. Тот же хук в своём разделе ───────────────────────────────────────
    await open(page, web, '/hooks');
    await frame(scenario, page, '03-hooks');
  } finally {
    await page.close();
  }
}

/**
 * Переход дорисован: в `main` есть текст. Холодный Vite одноразовой панели
 * собирает ленивый маршрут дольше фиксированной паузы, и кадр выходил пустым.
 */
async function settled(page) {
  // Клик уводит с обзора не сразу: без ожидания адреса текст в `main` — ещё
  // старой страницы.
  await page.waitForURL((url) => url.pathname !== '/', { timeout: 30_000 });
  await page.waitForFunction(
    () => (document.querySelector('main')?.textContent ?? '').trim().length > 40,
    null,
    { timeout: 30_000 },
  );
  await page.waitForTimeout(800);
}
