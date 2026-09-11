/**
 * Сценарии «Аналитики»: отчёт за период и живой срез.
 *
 * Входа два, и они противоположны по природе данных. `report` — это ПРОШЛОЕ,
 * посчитанное обходом транскриптов: цифры не меняются, пока не появится новый
 * ответ модели. `live` — НАСТОЯЩЕЕ, и считается оно не по файлам, а по списку
 * процессов машины, обновляясь само каждые пять секунд. Смешать их в один путь
 * значило бы утверждать, что «работает сейчас» — часть отчёта; это разные
 * источники, и человек приходит за ними в разные минуты.
 *
 * Отчёт собран настоящим сканером по настоящим `.jsonl` фикстуры. Подменён
 * только живой срез: поднимать настоящие процессы Claude Code ради двух строк
 * с номерами — это запускать агентов на чужой машине.
 */
import { settings, location, liveAgents, open, frame } from './watching-stubs.mjs';

export async function shootReport(browser, web, scenario) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });

  try {
    await settings(page);
    await location(page);
    // Пустой живой срез: он честен для стенда съёмки и не отвлекает от отчёта.
    await liveAgents(page, []);

    // ── 01. Период по умолчанию — сегодня ────────────────────────────────────
    await open(page, web, '/analytics', 3000);
    await frame(scenario, page, '01-today');

    // ── 02. Тридцать дней: появляется график по дням ─────────────────────────
    await page.getByRole('button', { name: /^(30 дней|30 days)$/ }).click();
    await page.waitForTimeout(3000);
    await frame(scenario, page, '02-month');

    // ── 03. Столбец модели — дверь в разбивку ────────────────────────────────
    await page
      .getByRole('button', { name: /claude-/ })
      .first()
      .click();
    await page.waitForSelector('[role="dialog"]');
    await page.waitForTimeout(800);
    await frame(scenario, page, '03-detail', { clip: '[role="dialog"]', padding: 40 });
    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);

    // ── 04. Часы суток, инструменты и скиллы ─────────────────────────────────
    await page
      .getByText(/Активность по часам суток|Activity by hour of day/)
      .scrollIntoViewIfNeeded();
    await page.waitForTimeout(800);
    await frame(scenario, page, '04-hours');

    // ── 05. Сессии, объём обхода и прямая оговорка про лимиты ────────────────
    await page.getByText(/Про лимиты подписки|About subscription limits/).scrollIntoViewIfNeeded();
    await page.waitForTimeout(800);
    await frame(scenario, page, '05-sessions');
  } finally {
    await page.close();
  }
}

export async function shootLive(browser, web, scenario) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 700 } });

  try {
    await settings(page);
    await location(page);

    // ── 01. Ничего не запущено ───────────────────────────────────────────────
    await liveAgents(page, []);
    await open(page, web, '/analytics', 3000);
    await frame(scenario, page, '01-idle');

    // ── 02. Два процесса: итог строкой, номера — по клику ────────────────────
    await liveAgents(page, [
      { pid: 24180, memoryMb: 612 },
      { pid: 31044, memoryMb: 488 },
    ]);
    await page.waitForTimeout(6000);
    await page.locator('details summary').first().click();
    await page.waitForTimeout(600);
    await frame(scenario, page, '02-running');
  } finally {
    await page.close();
  }
}
