/**
 * Плавность анимаций.
 *
 * Плавность — это не «значение меняется постепенно», а отсутствие перевёрстки:
 * если по ходу анимации подписи переносятся, значки едут или появляется полоса
 * прокрутки, глаз видит рывок даже при идеальной интерполяции. Поэтому здесь
 * замеряется геометрия внутренностей, а не только внешний размер.
 */
import { chromium } from 'playwright';

const BASE_URL = process.env.APP_URL ?? 'http://localhost:8888';

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

const consoleErrors = [];
page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`));
page.on('console', (m) => {
  if (m.type() === 'error') consoleErrors.push(`console: ${m.text().slice(0, 140)}`);
});

const failures = [];
const check = (ok, description) => {
  if (!ok) failures.push(description);
  console.log(`${ok ? '✓' : '✗'} ${description}`);
};

await page.emulateMedia({ colorScheme: 'dark' });
await page.goto(`${BASE_URL}/`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('nav');
await page.waitForTimeout(2500);

// === Сайдбар ===
const probeNav = () =>
  page.evaluate(() => {
    const nav = document.querySelector('nav');
    const links = [...nav.querySelectorAll('a')].slice(0, 6);
    return {
      width: Math.round(nav.getBoundingClientRect().width),
      scrollLeft: Math.round(nav.scrollLeft),
      iconLeft: Math.round(links[0].querySelector('svg').getBoundingClientRect().left),
      heights: links.map((l) => Math.round(l.getBoundingClientRect().height)).join(','),
    };
  });

// Клик через DOM: обычный click ждёт, пока элемент перестанет двигаться,
// а нам нужно снимать кадры именно во время движения.
const toggle = () => page.evaluate(() => document.querySelector('[data-sidebar-toggle]').click());

const recordNav = async () => {
  const frames = [];
  for (let i = 0; i < 10; i += 1) {
    frames.push(await probeNav());
    await page.waitForTimeout(35);
  }
  return frames;
};

await toggle();
const collapsing = await recordNav();
await page.waitForTimeout(1200);
await toggle();
const expanding = await recordNav();
const navFrames = [...collapsing, ...expanding];

check(
  new Set(navFrames.map((f) => f.iconLeft)).size === 1,
  `значки не едут при сворачивании (положений: ${new Set(navFrames.map((f) => f.iconLeft)).size})`,
);
check(
  new Set(navFrames.map((f) => f.heights)).size === 1,
  'строки меню не перевёрстываются по ходу анимации',
);
check(
  navFrames.every((f) => f.scrollLeft === 0),
  'панель не уезжает вбок вслед за фокусом',
);
check(
  new Set(collapsing.map((f) => f.width)).size > 3,
  `ширина именно анимируется, а не прыгает (кадров: ${new Set(collapsing.map((f) => f.width)).size})`,
);

// === Модальное окно ===
await page.waitForTimeout(1000);
await page.goto(`${BASE_URL}/rules`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1800);
await page
  .getByRole('button', { name: /Добавить правило/ })
  .first()
  .click();
await page.waitForTimeout(110);

const midOpen = await page
  .locator('[role="dialog"]')
  .evaluate((el) => Number(getComputedStyle(el).opacity))
  .catch(() => 1);
check(midOpen > 0 && midOpen < 1, `окно проявляется, а не возникает (прозрачность ${midOpen})`);

await page.waitForTimeout(800);
const centered = await page.locator('[role="dialog"]').evaluate((el) => {
  const box = el.getBoundingClientRect();
  return Math.abs(box.left + box.width / 2 - window.innerWidth / 2) < 2;
});
check(centered, 'открытое окно стоит по центру');

await page.keyboard.press('Escape');
await page.waitForTimeout(90);
check(
  (await page.locator('[role="dialog"]').count()) === 1,
  'закрытие доигрывается, а не обрывается',
);
await page.waitForTimeout(900);
check(
  (await page.locator('[role="dialog"]').count()) === 0,
  'после закрытия окно снято со страницы',
);

// === Режим «меньше движения» ===
await page.evaluate(() => {
  document.documentElement.dataset.reduceMotion = 'true';
});
await page.goto(`${BASE_URL}/`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1500);
await page.evaluate(() => {
  document.documentElement.dataset.reduceMotion = 'true';
});
await page.waitForTimeout(300);
const before = (await probeNav()).width;
await toggle();
await page.waitForTimeout(90);
const after = (await probeNav()).width;
check(
  before !== after && Math.abs(after - 60) < 6,
  `с «меньше движения» панель меняется сразу (${before} → ${after})`,
);

check(
  consoleErrors.length === 0,
  `ошибок в консоли нет${consoleErrors[0] ? `: ${consoleErrors[0]}` : ''}`,
);

await browser.close();
console.log(failures.length === 0 ? '\nАнимации плавные.' : `\nПровалено: ${failures.length}`);
process.exit(failures.length === 0 ? 0 : 1);
