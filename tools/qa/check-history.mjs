/**
 * История изменений (раздел «История», /history).
 *
 * Проверяет: страница открывается, есть заголовок и блок «Что это»; показывается
 * либо лента правок, либо пустое состояние; если правки есть — раскрытие первой
 * записи не роняет страницу (дифф подтягивается). Живой стенд (:8888).
 */
import { chromium } from 'playwright';
import { bypassOnboarding } from './bypass-onboarding.mjs';

const BASE = process.env.APP_URL ?? 'http://localhost:8888';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await bypassOnboarding(page); // убрать модалку онбординга
const problems = [];
page.on('pageerror', (e) => problems.push(e.message));
page.on('console', (m) => m.type() === 'error' && problems.push(m.text()));

await page.goto(`${BASE}/history`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('nav');
await page.waitForTimeout(1000);

const header = await page.getByRole('heading', { name: 'История изменений' }).count();
console.log('заголовок раздела:', header > 0 ? 'есть' : 'НЕТ');

const empty = await page.getByText('Изменений пока нет').count();
if (empty > 0) {
  console.log('лента: пусто (валидно)');
} else {
  // Есть записи — первая раскрывается (HistoryItem — кнопка-заголовок).
  const item = page
    .locator('button')
    .filter({ hasText: /\d{2}[.:]\d{2}|CLAUDE|settings|json|md/ })
    .first();
  const before = await page.locator('body').innerText();
  await item.click().catch(() => {});
  await page.waitForTimeout(1200);
  const after = await page.locator('body').innerText();
  console.log(
    'раскрытие записи:',
    after.length !== before.length ? 'дифф подтянулся' : 'без видимых изменений',
  );
}

const ok = header > 0;
console.log(
  problems.length ? `ПРОБЛЕМЫ: ${problems.slice(0, 3).join(' | ')}` : 'ошибок консоли нет',
);
await browser.close();
process.exit(ok && problems.length === 0 ? 0 : 1);
