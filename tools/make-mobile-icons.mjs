/**
 * Значки телефонного приложения из одного знака: `node tools/make-mobile-icons.mjs`.
 *
 * Знак тот же, что у панели в браузере (`apps/web/public/favicon.svg`) и что
 * оживает на заставке (`AppSplash.tsx`): кольцо с делениями и точка отсчёта —
 * пульт управления. Держать его в трёх местах руками нельзя, поэтому здесь он
 * описан один раз и раскладывается по всем размерам, которые просит Android:
 * передний план и фон адаптивного значка (система сама скругляет их по вкусу
 * прошивки), монохромный слой для «тематических» значков, картинка заставки и
 * значок для веб-сборки.
 *
 * Рисуется в браузере и снимается Playwright: SVG → PNG без сторонних
 * растеризаторов. Playwright в проекте уже есть — на нём держатся прогоны QA.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const assets = join(root, 'apps', 'mobile', 'assets', 'images');

/** Индиго панели — тот же, что в `favicon.svg` и в заставке. */
const BRAND = '#4f46e5';

/**
 * Пропорции знака — ровно те же, что в `apps/web/public/favicon.svg` (там
 * viewBox 32: кольцо r=8.5, штрих 2, деления «3.4 4.2», точка r=3.2). Здесь они
 * выражены долями радиуса кольца, чтобы знак был собой на любом размере.
 */
const STROKE = 2 / 8.5;
const DASH = 3.4 / 8.5;
const GAP = 4.2 / 8.5;
const DOT = 3.2 / 8.5;

/**
 * Знак в квадрате `size`.
 *
 * `scale` — доля стороны, которую занимает кольцо. У адаптивного значка Android
 * обрезает всё, что вне центральных двух третей, поэтому там знак мельче: иначе
 * на круглой маске от делений остаются огрызки.
 */
function mark({ size, scale, color = '#ffffff' }) {
  const center = size / 2;
  const radius = (size * scale) / 2;
  const round = (value) => value.toFixed(2);

  // Деления идут ВДОЛЬ окружности, а не лучами от центра, — это и делает знак
  // кольцом с делениями, а не солнцем. Проще всего так, как в исходной
  // фавиконке: штриховой обводкой круга.
  const ring = `<circle cx="${center}" cy="${center}" r="${round(radius)}" fill="none"
      stroke="${color}" stroke-width="${round(radius * STROKE)}" stroke-linecap="round"
      stroke-dasharray="${round(radius * DASH)} ${round(radius * GAP)}" opacity="0.75" />`;

  return `${ring}
    <circle cx="${center}" cy="${center}" r="${round(radius * DOT)}" fill="${color}" />`;
}

/** Полный документ: прозрачный фон, если `background` не задан. */
function page({ size, scale, background, rounded = 0, color }) {
  const plate = background
    ? `<rect width="${size}" height="${size}" rx="${rounded}" fill="${background}" />`
    : '';
  return `<!doctype html><html><body style="margin:0">
<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  ${plate}
  ${mark({ size, scale, color })}
</svg></body></html>`;
}

const FILES = [
  // Значок приложения целиком: плитка со скруглением, как у панели в браузере.
  { name: 'icon.png', size: 1024, scale: 0.56, background: BRAND, rounded: 230 },
  // Передний план адаптивного значка — только знак, фон отдельным слоем.
  { name: 'android-icon-foreground.png', size: 1024, scale: 0.42 },
  { name: 'android-icon-background.png', size: 1024, scale: 0, background: BRAND },
  // Монохромный слой: система сама покрасит его в цвет темы обоев.
  { name: 'android-icon-monochrome.png', size: 1024, scale: 0.42 },
  // Заставка: знак без фона, фон задаёт `app.json`, — и он же продолжается в
  // анимации, поэтому доля стороны здесь совпадает с той, что в `AppSplash`.
  { name: 'splash-icon.png', size: 512, scale: 0.42 },
  { name: 'favicon.png', size: 128, scale: 0.56, background: BRAND, rounded: 28 },
];

const browser = await chromium.launch();
const context = await browser.newContext({ deviceScaleFactor: 1 });
mkdirSync(assets, { recursive: true });

for (const file of FILES) {
  const tab = await context.newPage();
  await tab.setViewportSize({ width: file.size, height: file.size });
  await tab.setContent(page(file));
  const shot = await tab.screenshot({
    // Без фона снимок прозрачный — это и нужно слоям адаптивного значка.
    omitBackground: !file.background,
    type: 'png',
  });
  writeFileSync(join(assets, file.name), shot);
  await tab.close();
  console.log(`${file.name} — ${file.size}×${file.size}`);
}

await browser.close();
console.log('\nЗначки собраны. Чтобы они попали в приложение, нужна пересборка:');
console.log('  npx expo prebuild -p android  →  pnpm mobile:apk');
