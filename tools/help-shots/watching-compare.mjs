/**
 * Сценарии «Сравнения конфигураций»: посмотреть и перенести.
 *
 * Входа два, и разделены они не объёмом, а ценой ошибки. `look` — чтение:
 * человек выясняет, чем настройка одного CLI отличается от другого, и ничего на
 * диске не меняется. `move` — запись в файл ЧУЖОГО CLI, который до этого вели
 * руками; поэтому он идёт через предпросмотр, и половина его кадров про то,
 * чего панель делать откажется.
 *
 * Обе стороны настоящие: слева каталог фикстуры, справа её же `.codex/` с
 * собственным `config.toml` и `AGENTS.md`. Перенос в кадре 03 действительно
 * дописывает файл — потому `CODEX_HOME` и уведён в одноразовый каталог.
 */
import { settings, location, open, frame } from './watching-stubs.mjs';

/** Выбрать правую сторону и дождаться пересчёта сравнения. */
async function pickRight(page, providerId) {
  await page.getByLabel(/^(Справа|Right)$/).selectOption(providerId);
  await page.waitForTimeout(2000);
}

export async function shootLook(browser, web, scenario) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });

  try {
    await settings(page);
    await location(page);
    await open(page, web, '/compare', 2500);
    await pickRight(page, 'codex');

    // ── 01. Выбор сторон и первый раздел: MCP-серверы ────────────────────────
    await frame(scenario, page, '01-mcp');

    // ── 02. Переменные: секрет сверен по наличию, а не по значению ───────────
    // Прокрутка именно `block: 'start'`, а не `scrollIntoViewIfNeeded`: заголовок
    // раздела переменных виден и в первом кадре, поэтому «если нужно» не делало
    // ничего, и кадр выходил побайтово тем же, что 01.
    await page
      .getByText(/^(Переменные окружения|Environment variables)$/)
      .evaluate((node) => node.scrollIntoView({ block: 'start' }));
    await page.waitForTimeout(700);
    await frame(scenario, page, '02-env');

    // ── 03. Права и инструкции: «модели разные» и «отличается» ───────────────
    await page
      .getByText(/^(Глобальные инструкции|Global instructions)$/)
      .evaluate((node) => node.scrollIntoView({ block: 'start' }));
    await page.waitForTimeout(700);
    await frame(scenario, page, '03-instructions');
  } finally {
    await page.close();
  }
}

export async function shootMove(browser, web, scenario) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });

  try {
    await settings(page);
    await location(page);
    await open(page, web, '/compare', 2500);
    await pickRight(page, 'codex');

    // ── 01. Что переносить нельзя — видно до всякого клика ───────────────────
    await frame(scenario, page, '01-blocked');

    // ── 02. Отметили запись — кнопка стороны ожила ───────────────────────────
    await page.getByRole('checkbox', { name: 'design-mocks' }).check();
    await page.waitForTimeout(500);
    await frame(scenario, page, '02-selected');

    // ── 03. Предпросмотр: панель показывает дифф целевого файла ──────────────
    // Кнопка переноса есть у КАЖДОГО переносимого раздела — берём кнопку того,
    // в котором отмечена запись: у остальных она в это время погашена.
    await page
      .getByRole('button', { name: /^(Перенести в|Move into) Codex/ })
      .first()
      .click();
    await page.waitForSelector('[role="dialog"]');
    await page.waitForTimeout(1500);
    await frame(scenario, page, '03-preview', { clip: '[role="dialog"]', padding: 40 });

    // ── 04. После записи: запись есть у обеих сторон ─────────────────────────
    await page
      .locator('[role="dialog"]')
      .getByRole('button', { name: /^(Записать|Write)$/ })
      .click();
    await page.waitForTimeout(3000);
    await frame(scenario, page, '04-applied');
  } finally {
    await page.close();
  }
}
