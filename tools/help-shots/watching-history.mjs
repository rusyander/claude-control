/**
 * Сценарий «История изменений»: кто поменял файл и как вернуть один кусок.
 *
 * Вход один: человек заметил, что конфигурация ведёт себя не так, как вчера.
 * Дальше путь прямой — лента, дифф записи, возврат одного блока и то, что
 * получилось. Второго входа у раздела нет: смотреть ленту «просто так» не
 * приходят, а откат целиком живёт в настройках и в этот документ не входит.
 *
 * Все четыре кадра идут по настоящим файлам: копии лежат в каталоге фикстуры,
 * дифф считает сервер, а возврат блока НА САМОМ ДЕЛЕ переписывает CLAUDE.md —
 * последний кадр снят уже с изменённой лентой.
 */
import { settings, location, open, frame } from './watching-stubs.mjs';

export async function shootTrace(browser, web, scenario) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });

  try {
    await settings(page);
    await location(page);

    // ── 01. Лента: файл, время, против чего дифф и ±строк ────────────────────
    await open(page, web, '/history', 2000);
    await frame(scenario, page, '01-feed');

    // ── 02. Раскрытая запись: построчный дифф ────────────────────────────────
    // Запись ленты берётся по её тексту, а не по `aria-expanded`: тот же атрибут
    // носит кнопка сворачивания бокового меню, и первый прогон схлопнул меню
    // вместо того, чтобы раскрыть дифф.
    await page
      .getByRole('button', { name: /CLAUDE\.md.*(против текущего файла|vs current file)/ })
      .first()
      .click();
    await page.waitForTimeout(1500);
    await frame(scenario, page, '02-diff');

    // ── 03. Возврат одного блока подтверждается ──────────────────────────────
    await page
      .getByRole('button', { name: /^(Вернуть это изменение|Revert this change)$/ })
      .first()
      .click();
    await page.waitForSelector('[role="dialog"]');
    await page.waitForTimeout(600);
    await frame(scenario, page, '03-revert', { clip: '[role="dialog"]', padding: 40 });

    // ── 04. После возврата: у ленты новая запись ─────────────────────────────
    await page
      .locator('[role="dialog"]')
      .getByRole('button', { name: /^(Вернуть это изменение|Revert this change)$/ })
      .click();
    await page.waitForTimeout(2500);
    await frame(scenario, page, '04-after');
  } finally {
    await page.close();
  }
}
