/**
 * Автоскан доступности (axe-core) по ключевым разделам панели.
 *
 * Гоняется по живому стенду (`pnpm dev`, :8888). Для каждой страницы прогоняет
 * axe в обеих темах (светлой и тёмной) и печатает нарушения impact
 * critical/serious. Ненулевой код выхода — если такие нарушения нашлись, чтобы
 * скрипт годился и как гейт.
 *
 * Запуск: node tools/qa/check-a11y.mjs   (браузеры: pnpm qa:setup)
 */
import { chromium } from 'playwright';
import { AxeBuilder } from '@axe-core/playwright';
import { bypassOnboarding } from './bypass-onboarding.mjs';

const BASE = process.env.APP_URL ?? 'http://localhost:8888';

/** Разделы, по которым идём. Путь + маркер готовности (что должно отрисоваться). */
const PAGES = [
  { path: '/', name: 'Обзор' },
  {
    path: '/chat',
    name: 'Чат',
    // Лента вкладок проектов появляется только когда проект открыт, а это самый
    // насыщенный ролями кусок страницы: tablist, вкладки, точки статуса. Без
    // этого шага аудит смотрел на чат без ленты и её нарушений не видел.
    // Состояние кладём прямо в хранилище ленты: так проверка не зависит ни от
    // какой истории и не открывает настоящий проект.
    prepare: async (page) => {
      await page.evaluate(() => {
        localStorage.setItem(
          'claude-control:workspace',
          JSON.stringify({
            projectTabs: [{ id: 'c:/a11y', path: 'C:/a11y', name: 'Проверка ленты' }],
            activeTabId: 'home',
            views: {},
          }),
        );
      });
    },
    ready: '[role="tablist"][aria-label="Рабочие пространства"]',
  },
  { path: '/mcp', name: 'MCP' },
  { path: '/permissions', name: 'Права' },
  { path: '/settings', name: 'Настройки' },
  { path: '/search', name: 'Поиск' },
  { path: '/history', name: 'История изменений' },
  { path: '/projects', name: 'Проекты' },
];

/** Только значимые нарушения — impact critical/serious. */
const IMPACT = new Set(['critical', 'serious']);

const browser = await chromium.launch();
let totalViolations = 0;

for (const scheme of ['light', 'dark']) {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    colorScheme: scheme,
  });
  const page = await context.newPage();
  await bypassOnboarding(page); // иначе модалка онбординга прячет страницу

  for (const { path, name, prepare, ready } of PAGES) {
    await page.goto(`${BASE}${path}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('nav', { timeout: 15000 });
    if (prepare) {
      // Раздел, который сам себя не показывает целиком: доводим до нужного вида
      // и перезагружаем, чтобы страница поднялась уже с ним. Результат ждём
      // явно: молча не сработавший шаг оставил бы «чисто» пустым словом —
      // аудит смотрел бы ровно на ту же страницу, что и без подготовки.
      await prepare(page);
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForSelector('nav', { timeout: 15000 });
      await page.waitForSelector(ready, { timeout: 15000 });
    }
    await page.waitForTimeout(1200); // даём догрузиться данным раздела

    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();

    const serious = results.violations.filter((v) => IMPACT.has(v.impact));
    if (serious.length === 0) {
      console.log(`[${scheme}] ${name} (${path}) — чисто`);
      continue;
    }

    totalViolations += serious.length;
    console.log(`[${scheme}] ${name} (${path}) — нарушений: ${serious.length}`);
    for (const v of serious) {
      const nodes = v.nodes
        .slice(0, 3)
        .map((n) => n.target.join(' '))
        .join(' ; ');
      console.log(`   • [${v.impact}] ${v.id}: ${v.help}`);
      console.log(`     узлы: ${nodes}${v.nodes.length > 3 ? ' …' : ''}`);
    }
  }

  await page.close();
  await context.close();
}

await browser.close();

if (totalViolations > 0) {
  console.log(`\nИТОГО значимых нарушений: ${totalViolations}`);
  process.exit(1);
}
console.log('\nВсе разделы чисты (critical/serious не найдено).');
