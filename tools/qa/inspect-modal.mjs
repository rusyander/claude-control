/** Диагностика стилей модального окна: почему фон просвечивает. */
import { chromium } from 'playwright';

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

await page.goto('http://localhost:8888/rules', { waitUntil: 'domcontentloaded' });
await page.waitForSelector('nav');
await page.getByRole('button', { name: /Добавить правило/i }).click();
await page.waitForSelector('[role="dialog"]');

const measure = async (moment) => {
  const info = await page.locator('[role="dialog"]').evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      opacity: style.opacity,
      animationName: style.animationName,
      animationDuration: style.animationDuration,
      animationFillMode: style.animationFillMode,
      // Активные анимации: если пусто, значит анимация уже завершилась.
      running: element.getAnimations().map((a) => `${a.animationName ?? '?'}:${a.playState}`),
    };
  });
  console.log(moment, JSON.stringify(info));
};

await measure('сразу:      ');
await page.waitForTimeout(600);
await measure('через 600мс:');
await page.waitForTimeout(1500);
await measure('через 2.1с: ');

await browser.close();
