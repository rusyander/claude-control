/**
 * Сценарий `claudeMd/layers`: где ещё лежат инструкции.
 *
 * Второй вход в раздел — «правило написано, а агент его не выполняет». Почти
 * всегда это не отказ правила, а другой слой: у проекта есть свой `CLAUDE.md`
 * и свой каталог `.claude`, и Claude Code читает их вместе с личным файлом.
 *
 * Проект здесь настоящий, а не подменённый ответ: слои — это про файлы на
 * диске, и подложенный список доказывал бы только разметку. Каталог создаётся
 * съёмкой рядом с репозиторием и сносится в конце.
 */
import { openSection } from './rules-stubs.mjs';

export async function shootLayers(browser, web, scenario) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });

  try {
    // ── 01. Реестр проектов ──────────────────────────────────────────────────
    await openSection(page, web, '/projects', 2500);
    await scenario.shot(page, '01-projects');

    // ── 02. CLAUDE.md проекта ────────────────────────────────────────────────
    await page
      .getByRole('button', { name: /Панель заказов/ })
      .first()
      .click();
    await page.waitForTimeout(2500);
    await scenario.shot(page, '02-project-file');

    // ── 03. Собственный .claude проекта ──────────────────────────────────────
    // Вкладка ищется по обоим языкам сразу: съёмка идёт дважды (русская и
    // английская), а искать кнопку по русской надписи в английском интерфейсе
    // нечем. Точное совпадение сохранено — рядом есть вкладка «Правила».
    await page
      .getByRole('button', { name: /^(Из проекта|From the project)$/ })
      .first()
      .click();
    await page.waitForTimeout(2500);
    await scenario.shot(page, '03-project-local');
  } finally {
    await page.close();
  }
}
