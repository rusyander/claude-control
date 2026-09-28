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

/**
 * «Где идёт» для кадров 07–08: идёт в терминале. Каталог и номер сессии —
 * из настоящего ответа сервера; подменено только место процесса.
 */
async function sessionInTerminal(page) {
  await page.route('**/api/analytics/sessions/*/where', async (route) => {
    const real = await (await route.fetch()).json();
    const id = real.sessionId ?? '';
    route.fulfill({
      json: {
        ...real,
        where: {
          kind: 'process',
          pid: 41872,
          startedAt: new Date(Date.now() - 12 * 60_000).toISOString(),
          host: 'terminal',
          command: `claude --resume ${id}`,
          ownsPanel: false,
        },
      },
    });
  });
}

export async function shootReport(browser, web, scenario) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });

  try {
    await settings(page);
    await location(page);
    // Пустой живой срез: он честен для стенда съёмки и не отвлекает от отчёта.
    await liveAgents(page, []);

    // ── 01. Период по умолчанию — сегодня ────────────────────────────────────
    await open(page, web, '/analytics?tab=overview', 3000);
    await frame(scenario, page, '01-today');

    // ── 02. Тридцать дней: появляется график по дням ─────────────────────────
    await page.getByRole('button', { name: /^(30 дней|30 days)$/ }).click();
    await page.waitForTimeout(3000);
    await frame(scenario, page, '02-month');

    // ── 03. Столбец модели — дверь в разбивку ────────────────────────────────
    // Разрезы отчёта — вкладки; выбранный период при переходе остаётся.
    await page.getByRole('tab', { name: /^(Модели и проекты|Models and projects)/ }).click();
    await page.waitForTimeout(800);
    // ── 06. Вкладка «Модели и проекты» целиком ───────────────────────────────
    // Номер после 05 — кадр добавлен позже; в документе стоит перед 03.
    await frame(scenario, page, '06-breakdown');
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
    await page.getByRole('tab', { name: /^(Инструменты и часы|Tools and hours)/ }).click();
    await page.waitForTimeout(800);
    await frame(scenario, page, '04-hours');

    // ── 05. Сессии, объём обхода и прямая оговорка про лимиты ────────────────
    await page.getByRole('tab', { name: /^(Сессии|Sessions)/ }).click();
    await page.waitForTimeout(800);
    // Карточка про лимиты стоит под списком: кадр опускается к ней, иначе подпись
    // обещала бы то, чего на снимке нет.
    await page
      .getByText(/^(Про лимиты подписки|About subscription limits)$/)
      .first()
      .evaluate((node) => node.scrollIntoView({ block: 'end' }))
      .catch(() => null);
    await page.mouse.wheel(0, 120);
    await page.waitForTimeout(400);
    await frame(scenario, page, '05-sessions');

    // ── 07–08. «Перейти» и «Остановить» у идущей сессии ─────────────────────
    // Процесс CLI на стенде съёмки не запущен, поэтому ответ «где идёт»
    // подменён: всё, кроме места (номер, команда), — настоящее от сервера.
    await sessionInTerminal(page);
    await page.getByRole('tab', { name: /^(Сводка|Summary)/ }).click();
    await page.getByRole('tab', { name: /^(Сессии|Sessions)/ }).click();
    await page.waitForTimeout(800);
    await page
      .getByRole('button', { name: /^(Перейти|Go to): / })
      .first()
      .click();
    await page.waitForSelector('[role="dialog"]');
    await page.waitForTimeout(600);
    await frame(scenario, page, '07-session-where', { clip: '[role="dialog"]', padding: 40 });
    await page.keyboard.press('Escape');
    await page.waitForTimeout(400);
    await page
      .getByRole('button', { name: /^(Остановить|Stop): / })
      .first()
      .click();
    await page.waitForSelector('[role="dialog"]');
    await page.waitForTimeout(600);
    await frame(scenario, page, '08-session-stop', { clip: '[role="dialog"]', padding: 40 });
    await page.keyboard.press('Escape');
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
    await open(page, web, '/analytics?tab=live', 3000);
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
