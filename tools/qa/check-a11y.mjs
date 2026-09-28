/**
 * Автоскан доступности (axe-core) по всем разделам панели.
 *
 * Гоняется по живому стенду (`pnpm dev`, :8888). Для каждого раздела прогоняет
 * axe в обеих темах (светлой и тёмной), а там, где есть кнопка создания, — ещё
 * и с открытой модалкой. Печатает нарушения impact critical/serious; moderate
 * считаются справочно и прогон не роняют. Ненулевой код выхода — если значимые
 * нарушения нашлись, чтобы скрипт годился и как гейт.
 *
 * Запуск: node tools/qa/check-a11y.mjs [--report] [--only <строка>]   (браузеры: pnpm qa:setup)
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

// `--only <строка>` — разделы, чей путь, имя или slug содержит строку (под Git
// Bash без ведущего `/`: он превращает `/hooks` в путь Windows).
const onlyAt = process.argv.indexOf('--only');
const only = onlyAt >= 0 ? process.argv[onlyAt + 1] : undefined;
const entries = PANEL_PAGES.filter(
  (entry) => !only || entry.path.includes(only) || entry.name.includes(only) || entry.slug === only,
);
// Фильтр, под который не подошёл ни один раздел, — не «нарушений нет».
if (entries.length === 0) {
  console.log(`Ни один раздел не подошёл под --only «${only}» — проверять нечего.`);
  process.exit(2);
}

/** Только значимые нарушения — impact critical/serious. */
const IMPACT = new Set(['critical', 'serious']);

const browser = await chromium.launch();
let totalViolations = 0;
let totalModerate = 0;

let totalUnverified = 0;

/**
 * Конец анимаций появления перед разбором — в каждом разделе, а не у отдельных
 * записей: окно, открытое в `interact`, проявляется анимацией, и axe на
 * полупрозрачном кадре мерил контраст текста неверно (27.09.2026: 1–20
 * «нарушений» на модалке /scripts и окне групп, 0 после конца анимации).
 * Бесконечные (спиннеры) не ждём — они не кончаются; потолок 5 с.
 */
async function settleAnimations(page) {
  // Анимация окна стартует кадром позже, чем окно стало видимым (motion ставит
  // её после отрисовки): одиночный опрос под нагрузкой стенда видел пустой
  // список, и axe мерил полупрозрачный кадр (28.09: «Права — модалка создания»,
  // 5–19 узлов в первые миллисекунды, 0 после конца анимации в 3 из 3 открытий).
  // Поэтому опрос повторяется через два кадра, пока анимаций не останется.
  await page
    .evaluate(async () => {
      const frame = () => new Promise((done) => requestAnimationFrame(() => done()));
      const deadline = performance.now() + 5000;
      while (performance.now() < deadline) {
        await frame();
        await frame();
        const running = document.getAnimations().filter(
          // Только идущие: приостановленная не кончится никогда и съела бы потолок.
          (a) => a.effect?.getTiming().iterations !== Infinity && a.playState === 'running',
        );
        if (running.length === 0) return;
        await Promise.race([
          Promise.all(running.map((a) => a.finished.catch(() => null))),
          new Promise((done) => setTimeout(done, Math.max(0, deadline - performance.now()))),
        ]);
      }
    })
    .catch(() => null);
  await page.waitForTimeout(100);
}

async function audit(page, label, file) {
  let results;
  await settleAnimations(page);
  try {
    results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
  } catch (error) {
    // Стенд перезагрузил страницу посреди разбора (горячая перезагрузка от чужой
    // правки): разбирать уже нечего, а повтор на перезагруженной странице судил
    // бы другое состояние — открытое окно пропало. Раздел называется поимённо
    // как непроверенный, и обход идёт дальше, а не падает на середине.
    if (!/Execution context was destroyed|Target closed|navigation/i.test(String(error)))
      throw error;
    totalUnverified += 1;
    console.log(`${label} — НЕ ПРОВЕРЕНО: стенд перезагрузил страницу во время разбора`);
    return;
  }
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

  for (const entry of entries) {
    const { path, name } = entry;
    // Раздел, который не удалось довести до проверяемого вида (стенд лёг,
    // подмена раздела отстала от его разметки), — непроверенный, а не повод
    // уронить обход остальных шестидесяти.
    try {
      await openPanelPage(page, BASE, entry);
    } catch (error) {
      totalUnverified += 1;
      console.log(
        `[${scheme}] ${name} (${path}) — НЕ ПРОВЕРЕНО: раздел не открылся — ${String(error.message).split('\n')[0]}`,
      );
      continue;
    }

    const slug = pageSlug(path, entry.slug);
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
    await audit(page, `[${scheme}] ${name} — модалка создания`, `${slug}.dialog.${scheme}.json`);
    await page.keyboard.press('Escape');
  }

  await page.close();
  await context.close();
}

await browser.close();

const unverified = totalUnverified
  ? `; НЕ проверено из-за перезагрузки стенда: ${totalUnverified}`
  : '';
if (totalViolations > 0) {
  console.log(
    `\nИТОГО значимых нарушений: ${totalViolations} (moderate: ${totalModerate}${unverified})`,
  );
  process.exit(1);
}
// Непроверенный раздел — не «чисто»: итог его называет, а код выхода не даёт
// принять обход с дырой за зелёный.
if (totalUnverified > 0) {
  console.log(`\nНарушений не найдено, но обход неполон${unverified}.`);
  process.exit(1);
}
console.log(`\nВсе разделы чисты (critical/serious не найдено; moderate: ${totalModerate}).`);
