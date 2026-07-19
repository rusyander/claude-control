/** Прогон витрины: все истории открываются, ошибок в консоли нет. */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const BASE = process.env.SB_URL ?? 'http://localhost:6006';
const OUT = '.agent/tmp/storybook-shots';
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });

const problems = [];
page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
page.on('console', (m) => {
  const text = m.text();
  if (m.type() !== 'error') return;
  // Шум самого Storybook про телеметрию и sourcemap игнорируем.
  if (/telemetry|sourcemap|favicon/i.test(text)) return;
  problems.push(`console: ${text.slice(0, 160)}`);
});

// Список историй Storybook отдаёт индексом.
const index = await (await fetch(`${BASE}/index.json`)).json();
const stories = Object.values(index.entries).filter((e) => e.type === 'story');
console.log(`историй: ${stories.length}`);

const open = async (id) => {
  problems.length = 0;
  await page.goto(`${BASE}/iframe.html?id=${id}&viewMode=story`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(420);

  return page.evaluate(() => {
    const root = document.querySelector('#storybook-root');
    return Boolean(root && root.textContent !== null && root.innerHTML.length > 20);
  });
};

const failed = [];
for (const story of stories) {
  let rendered = await open(story.id);

  // Вторая попытка при пустом кадре: на дев-сервере горячая перезагрузка может
  // попасть ровно между переходом и замером, и история отметится пустой,
  // хотя с ней всё в порядке. Настоящая поломка переживёт и второй заход.
  if (!rendered) {
    await page.waitForTimeout(1200);
    rendered = await open(story.id);
  }

  if (!rendered || problems.length > 0) {
    failed.push({ id: story.id, rendered, problems: [...problems] });
  }
}

// Снимки нескольких показательных историй в обеих темах.
const showcase = [
  ['компоненты-button--виды', 'button'],
  ['компоненты-card--в-жизни', 'card'],
  ['основы-токены--цвета', 'tokens'],
  ['компоненты-modal--размеры', 'modal'],
];

for (const [id, name] of showcase) {
  for (const theme of ['dark', 'light']) {
    await page.goto(`${BASE}/iframe.html?id=${id}&viewMode=story&globals=theme:${theme}`, {
      waitUntil: 'domcontentloaded',
    });
    await page.waitForTimeout(700);
    await page.screenshot({ path: join(OUT, `${name}-${theme}.png`) });
  }
}

console.log(JSON.stringify({ всего: stories.length, сломано: failed.length, failed }, null, 2));
await browser.close();
process.exit(failed.length === 0 ? 0 : 1);
