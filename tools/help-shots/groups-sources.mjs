/**
 * Сценарий `groups/sources`: откуда берутся группы.
 *
 * Вход — «у проекта уже есть свой порядок работы, а панель о нём не знает».
 * Путь: сетка карточек и ход обнаружения по источникам → окно находки, которую
 * можно импортировать → окно связанной пары с выбором стороны и
 * переопределением → копия проектной группы в общие и советы агента → слияние
 * изменившегося оригинала → «Состав»: где группа используется → «Копировать»:
 * своя выключенная копия рядом.
 *
 * Данные — общая подмена страницы групп (`tools/qa/check-group-*.mjs` ходят по
 * ней же): находки требуют проектов на диске и модели, копия пишет в ~/.claude.
 * Кадры сняты после настоящих щелчков по настоящему интерфейсу.
 */
import { installGroupStubs, openGroup } from '../qa/group-stubs.mjs';
import { makeState, settings, panelShell, open } from './projects-stubs.mjs';

const PAIR = '[data-agent-anchor="qa-shop-order-global"]';
// Окна бывают вложенными (копия поверх окна группы) — снимаем верхнее.
const TOP_DIALOG = '[role="dialog"] >> nth=-1';

/** Закрыть верхнее окно: сначала увести указатель — показанная подсказка съела бы Escape. */
async function closeTop(page) {
  const before = await page.locator('[role="dialog"]').count();
  await page.mouse.move(0, 0);
  await page.waitForTimeout(200);
  await page.keyboard.press('Escape');
  await page.waitForFunction(
    (count) => document.querySelectorAll('[role="dialog"]').length < count,
    before,
    { timeout: 8000 },
  );
}

export async function shootSources(browser, web, scenario) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });

  try {
    await settings(page);
    await panelShell(page, makeState());
    await installGroupStubs(page);

    // ── 01. Сетка карточек и ход обнаружения ─────────────────────────────────
    await open(page, web, '/groups');
    await page.locator(PAIR).waitFor({ timeout: 15000 });
    await page.waitForTimeout(600);
    await scenario.shot(page, '01-sections');

    // ── 02. Окно находки: «Когда», почему это набор, импорт в шапке ──────────
    // Имя находки — на языке интерфейса (пара `localized`), в английской съёмке оно своё.
    await openGroup(page, /^(Выпуск релиза|Store release)$/);
    await page.waitForTimeout(600);
    await scenario.shot(page, '02-found', { clip: TOP_DIALOG, padding: 24 });
    await closeTop(page);

    // ── 03. Окно пары: выбор стороны, переопределение ────────────────────────
    const pair = await openGroup(page, 'Порядок задачи (общий)');
    await pair.getByRole('list').first().waitFor({ timeout: 8000 });
    await page.waitForTimeout(600);
    await scenario.shot(page, '03-pair', { clip: TOP_DIALOG, padding: 24 });
    await closeTop(page);

    // ── 04. Копия проектной группы в общие: советы и предупреждения ─────────
    const site = await openGroup(page, 'Документация сайта');
    await site.getByRole('button', { name: /^(Скопировать в общие|Copy to global)$/ }).click();
    const copy = page.getByRole('dialog', { name: /^(Копия|Copy)/ });
    await copy.getByRole('button', { name: /^(Скопировать|Copy)$/ }).click();
    await copy.locator('ul').first().waitFor({ timeout: 8000 });
    await page.waitForTimeout(600);
    await scenario.shot(page, '04-copy', { clip: TOP_DIALOG, padding: 40 });
    await copy.getByRole('button', { name: /^(Готово|Done)$/ }).click();
    await copy.waitFor({ state: 'detached', timeout: 8000 });
    if (await site.isVisible()) await closeTop(page);

    // ── 05. Оригинал изменился: слияние в нашу копию ─────────────────────────
    const pairAgain = await openGroup(page, 'Порядок задачи (общий)');
    await pairAgain
      .getByRole('button', { name: /^(Слить в нашу копию|Merge into our copy)$/ })
      .click();
    const merge = page.getByRole('dialog', { name: /^(Слияние|Merge)/ });
    await merge.locator('ul').first().waitFor({ timeout: 8000 });
    await page.waitForTimeout(600);
    await scenario.shot(page, '05-merge', { clip: TOP_DIALOG, padding: 40 });
    await closeTop(page);

    // ── 06. «Состав»: участники, где найдено, где используется ───────────────
    await pairAgain.getByRole('tab', { name: /^(Состав|Members)$/ }).click();
    await page.waitForTimeout(800);
    await scenario.shot(page, '06-details', { clip: TOP_DIALOG, padding: 24 });
    await closeTop(page);

    // ── 07. «Копировать»: своя выключенная копия рядом, имя «(копия)» ────────
    const manual = await openGroup(page, 'Фронтенд-работа');
    await manual.getByRole('button', { name: /^(Копировать|Copy)$/ }).click();
    const duplicate = page.getByRole('dialog', { name: /^(Копировать группу|Copy group)/ });
    await duplicate.waitFor({ timeout: 8000 });
    await duplicate.evaluate((node) =>
      Promise.all(node.getAnimations({ subtree: true }).map((a) => a.finished)),
    );
    await page.waitForTimeout(300);
    await scenario.shot(page, '07-duplicate', { clip: TOP_DIALOG, padding: 40 });
  } finally {
    await page.close();
  }
}
