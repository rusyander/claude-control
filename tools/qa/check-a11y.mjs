/**
 * Автоскан доступности (axe-core) по всем разделам панели.
 *
 * Гоняется по живому стенду (`pnpm dev`, :8888). Для каждого раздела прогоняет
 * axe в обеих темах (светлой и тёмной), а там, где есть кнопка создания, — ещё
 * и с открытой модалкой. Печатает нарушения impact critical/serious; moderate
 * считаются справочно и прогон не роняют. Ненулевой код выхода — если значимые
 * нарушения нашлись, чтобы скрипт годился и как гейт.
 *
 * Запуск: node tools/qa/check-a11y.mjs [--report]   (браузеры: pnpm qa:setup)
 * `--report` складывает полные отчёты axe по разделам в `.agent/tmp/a11y/`.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { AxeBuilder } from '@axe-core/playwright';
import { bypassOnboarding } from './bypass-onboarding.mjs';
import { PANEL_PAGES, findCreateButton, openPanelPage, pageSlug } from './panel-pages.mjs';

const BASE = process.env.APP_URL ?? 'http://localhost:8888';
const REPORT_DIR = process.argv.includes('--report') ? join('.agent', 'tmp', 'a11y') : null;
if (REPORT_DIR) mkdirSync(REPORT_DIR, { recursive: true });

/** Только значимые нарушения — impact critical/serious. */
const IMPACT = new Set(['critical', 'serious']);

const browser = await chromium.launch();
let totalViolations = 0;
let totalModerate = 0;

async function audit(page, label, file) {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  if (REPORT_DIR)
    writeFileSync(join(REPORT_DIR, file), JSON.stringify(results.violations, null, 2));

  const serious = results.violations.filter((v) => IMPACT.has(v.impact));
  const moderate = results.violations.filter((v) => v.impact === 'moderate');
  totalModerate += moderate.length;
  const note = moderate.length ? ` (moderate: ${moderate.map((v) => v.id).join(', ')})` : '';

  if (serious.length === 0) {
    console.log(`${label} — чисто${note}`);
    return;
  }

  totalViolations += serious.length;
  console.log(`${label} — нарушений: ${serious.length}${note}`);
  for (const v of serious) {
    const nodes = v.nodes
      .slice(0, 3)
      .map((n) => n.target.join(' '))
      .join(' ; ');
    console.log(`   • [${v.impact}] ${v.id}: ${v.help}`);
    console.log(`     узлы: ${nodes}${v.nodes.length > 3 ? ' …' : ''}`);
  }
}

for (const scheme of ['light', 'dark']) {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    colorScheme: scheme,
  });
  const page = await context.newPage();
  await bypassOnboarding(page); // иначе модалка онбординга прячет страницу

  for (const entry of PANEL_PAGES) {
    const { path, name } = entry;
    await openPanelPage(page, BASE, entry);

    const slug = pageSlug(path);
    await audit(page, `[${scheme}] ${name} (${path})`, `${slug}.${scheme}.json`);

    // Модалка создания: самый насыщенный формами кусок раздела. Открылась —
    // проверяем и её; кнопки нет или она ведёт не в модалку — раздел просто
    // без модалки, не ошибка.
    const create = await findCreateButton(page);
    if (!create) continue;
    await create.click({ timeout: 3000 }).catch(() => null);
    const dialog = page.locator('[role="dialog"]').first();
    const opened = await dialog.waitFor({ state: 'visible', timeout: 2500 }).then(
      () => true,
      () => false,
    );
    if (!opened) continue;
    await page.waitForTimeout(400);
    await audit(page, `[${scheme}] ${name} — модалка создания`, `${slug}.dialog.${scheme}.json`);
    await page.keyboard.press('Escape');
  }

  await page.close();
  await context.close();
}

await browser.close();

if (totalViolations > 0) {
  console.log(`\nИТОГО значимых нарушений: ${totalViolations} (moderate: ${totalModerate})`);
  process.exit(1);
}
console.log(`\nВсе разделы чисты (critical/serious не найдено; moderate: ${totalModerate}).`);
