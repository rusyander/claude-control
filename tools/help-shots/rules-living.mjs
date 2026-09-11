/**
 * Сценарий `rules/living`: правила уже написаны.
 *
 * Второй вход в раздел — не «как завести», а «почему так» и «как этим
 * управлять»: список и поиск, выключение без потери текста и самый частый
 * вопрос живого `CLAUDE.md` — «правил ноль, хотя файл не пустой».
 *
 * Кадры 03 и 04 — одно и то же действие с двух сторон: тумблер в списке и
 * последствие в файле. Порознь они ничего не доказывают, поэтому и сняты
 * подряд, одним переходом.
 */
import { setClaudeMd, RULES_CLAUDE_MD, PLAIN_CLAUDE_MD } from './rules-fixture.mjs';
import { openSection } from './rules-stubs.mjs';

export async function shootLiving(browser, web, scenario, home) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });

  try {
    setClaudeMd(home, RULES_CLAUDE_MD);

    // ── 01. Список правил ────────────────────────────────────────────────────
    await openSection(page, web, '/rules');
    await scenario.shot(page, '01-list');

    // ── 02. Поиск не нашёл ───────────────────────────────────────────────────
    // Своя заглушка с запросом: раньше промах поиска уверял, что «правил пока
    // нет», хотя правила есть.
    await page
      .getByRole('searchbox', { name: /^(Поиск|Search)$/ })
      .first()
      .fill('миграции');
    await page.waitForTimeout(1200);
    await scenario.shot(page, '02-search');

    await page
      .getByRole('searchbox', { name: /^(Поиск|Search)$/ })
      .first()
      .fill('');
    await page.waitForTimeout(1000);

    // ── 03. Правило выключено ────────────────────────────────────────────────
    await page.getByRole('switch', { name: 'Коммиты только по просьбе' }).first().click();
    await page.waitForTimeout(2500);
    await scenario.shot(page, '03-off');

    // ── 04. Что стало с файлом ───────────────────────────────────────────────
    // Текст выключенного правила не пропал: панель перенесла его в служебный
    // раздел в конце файла. Поле прокручено вниз — именно туда, где он теперь.
    await openSection(page, web, '/claude-md', 2500);
    const editor = page.locator('textarea').first();
    await editor.evaluate((node) => node.scrollTo(0, node.scrollHeight));
    await page.waitForTimeout(600);
    await scenario.shot(page, '04-file-disabled');

    // ── 05. «0 правил» на непустом файле ─────────────────────────────────────
    // Файл размечен обычными «## » разделами: карточек нет, и страница обязана
    // объяснить это сама, а не показать пустой счётчик.
    setClaudeMd(home, PLAIN_CLAUDE_MD);
    await openSection(page, web, '/rules', 2500);
    await scenario.shot(page, '05-zero');
  } finally {
    await page.close();
  }
}
