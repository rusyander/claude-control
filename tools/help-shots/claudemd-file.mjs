/**
 * Сценарий `claudeMd/file`: файл целиком.
 *
 * Раздел «Правила» показывает карточки, но не показывает файл: шапку,
 * произвольные разделы, порядок и пустые строки видно только здесь. Сценарий
 * идёт по тому, ради чего сюда заходят, — прочитать файл, поправить руками,
 * сохранить, — и заканчивается единственной неочевидностью раздела:
 * расхождением с диском, когда файл изменили снаружи.
 *
 * Расхождение снимается НАСТОЯЩЕЕ: пока в поле лежит несохранённая правка,
 * файл переписывается на диске, наблюдатель файлов сообщает об этом панели, и
 * она сама показывает карточку. Подложить такое состояние было бы легче, но
 * тогда кадр доказывал бы разметку, а не поведение.
 */
import { setClaudeMd, RULES_CLAUDE_MD } from './rules-fixture.mjs';
import { openSection } from './rules-stubs.mjs';

/** Чем правится файл снаружи, пока страница открыта: пятое правило в конце. */
const FROM_OUTSIDE = `${RULES_CLAUDE_MD}
## ПРАВИЛО: Отвечать коротко

Сначала суть и цифры, потом подробности — и только если их спросили.
`;

export async function shootFile(browser, web, scenario, home) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });

  try {
    setClaudeMd(home, RULES_CLAUDE_MD);

    // ── 01. Файл целиком ─────────────────────────────────────────────────────
    await openSection(page, web, '/claude-md', 2500);
    await scenario.shot(page, '01-editor');

    // ── 02. Несохранённые правки ─────────────────────────────────────────────
    const editor = page.locator('textarea').first();
    await editor.click();
    await editor.press('Control+End');
    await editor.type(
      '\n## ПРАВИЛО: Спрашивать при развилке\n\nДва прочтения задачи — остановиться и спросить.\n',
    );
    await page.waitForTimeout(1000);
    await scenario.shot(page, '02-unsaved');

    // ── 03. Файл изменился на диске ──────────────────────────────────────────
    // Правка снаружи — обычное дело: тот же файл правит сам Claude Code, чужой
    // редактор и соседний раздел «Правила».
    setClaudeMd(home, FROM_OUTSIDE);
    await page.waitForTimeout(4000);
    await scenario.shot(page, '03-conflict');
  } finally {
    await page.close();
  }
}
