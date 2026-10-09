/**
 * Раздел прав Continue называет правила, которые `cn` примет и не применит.
 *
 * Живая проба 09.10.2026 (cn 1.5.47): `exclude: Read(.env)` лежал в
 * `permissions.yaml`, а `cn` файл читал — его разбор сверяет уточнение у `Read`,
 * `Write` и `List` с аргументом, которого у этих инструментов нет. Человек,
 * записавший такой запрет в панели, считал файл закрытым.
 *
 * Путь человека в настоящем фронте на своём одноразовом стенде (активный CLI —
 * Continue, дом временный, `cn` не нужен — раздел читает и пишет только файл):
 *   1. в «Спрятать инструмент» вписать `Read(.env)` → под формой предупреждение,
 *      в нём названо правило;
 *   2. заменить на `Read` (инструмент целиком) → предупреждения нет;
 *   3. `Bash(git push)` → предупреждения нет (уточнение у Bash `cn` сверяет).
 * Ничего не сохраняется: предупреждение обязано появиться ДО записи.
 *
 * Запуск: `node tools/qa/check-continue-permissions-warning.mjs`
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { REPO, runOnStand } from './throwaway-stand.mjs';
import { bypassOnboarding } from './bypass-onboarding.mjs';

const SHOTS = join(REPO, '.agent', 'screenshots', 'before-after', 'continue-unenforced');
mkdirSync(SHOTS, { recursive: true });

await runOnStand(
  { label: 'cn-perm-warn', settings: { provider: 'continue' } },
  async (stand, check) => {
    const browser = await chromium.launch();
    try {
      const page = await stand.newPage(browser);
      await bypassOnboarding(page, { provider: 'continue' });
      await page.goto(`${stand.webUrl}/permissions`);
      const exclude = page.getByLabel('Спрятать инструмент (exclude)');
      await exclude.waitFor({ timeout: 30_000 });
      const warning = page.getByRole('status').filter({ hasText: 'не применяет шаблон' });

      await exclude.fill('Read(.env)');
      await warning.waitFor({ timeout: 5_000 }).catch(() => {});
      const shown = await warning.isVisible();
      check('Read(.env) — предупреждение под формой', shown);
      check(
        'в предупреждении названо само правило',
        shown && (await warning.textContent())?.includes('Read(.env)'),
      );
      // Прокрутка у панели — своя у <main>, а не у страницы: fullPage её не видит.
      if (shown) await warning.scrollIntoViewIfNeeded();
      await page.screenshot({ path: join(SHOTS, 'unenforced_AFTER.png') });

      await exclude.fill('Read');
      check('Read целиком — предупреждения нет', !(await warning.isVisible()));

      await exclude.fill('Bash(git push)');
      check('Bash(git push) — предупреждения нет', !(await warning.isVisible()));

      check('ошибок страницы нет', page.errors.length === 0, page.errors.join(' | '));
    } finally {
      await browser.close();
    }
  },
);
