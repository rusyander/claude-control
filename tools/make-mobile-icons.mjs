/**
 * Значки приложения из одного знака: `node tools/make-mobile-icons.mjs`.
 *
 * Знак тот же, что у панели в браузере (`apps/web/public/favicon.svg`) и что
 * оживает на заставке (`AppSplash.tsx`): кольцо с делениями и точка отсчёта —
 * пульт управления. Держать его в трёх местах руками нельзя, поэтому здесь он
 * описан один раз и раскладывается по всем размерам, которые просит Android:
 * передний план и фон адаптивного значка (система сама скругляет их по вкусу
 * прошивки), монохромный слой для «тематических» значков, картинка заставки и
 * значок для веб-сборки — и значки панели как приложения на компьютере
 * (`apps/web/public/icons/`, на них ссылается `manifest.webmanifest`).
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
const webIcons = join(root, 'apps', 'web', 'public', 'icons');

/** Плитка значка — тот же градиент, что в `favicon.svg`: светлее сверху слева. */
const GRADIENT = ['#3b82f6', '#1d4ed8'];

/**
 * Пропорции знака — ровно те же, что в `apps/web/public/favicon.svg` (там
 * viewBox 32: кольцо r=8.6, штрих 2.8, деления «4.2 4.8», поворот −75°, точка
 * r=3.3). Здесь они выражены долями радиуса кольца, чтобы знак был собой на
 * любом размере. Штрих толще прежнего: на 16 px тонкое кольцо сливалось в
 * сплошное.
 */
const STROKE = 2.8 / 8.6;
const DASH = 4.2 / 8.6;
const GAP = 4.8 / 8.6;
const DOT = 3.3 / 8.6;
const TURN = -75;
/** Доля стороны под кольцо на плитке — как у `favicon.svg`: 17.2 из 32. */
const ON_PLATE = 17.2 / 32;

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
      stroke-dasharray="${round(radius * DASH)} ${round(radius * GAP)}"
      transform="rotate(${TURN} ${center} ${center})" />`;

  return `${ring}
    <circle cx="${center}" cy="${center}" r="${round(radius * DOT)}" fill="${color}" />`;
}

/** Полный документ: прозрачный фон, если `background` не задан. */
function page({ size, scale, background, rounded = 0, color }) {
  const fill = background === 'gradient' ? 'url(#plate)' : background;
  const plate = background
    ? `<defs><linearGradient id="plate" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="${GRADIENT[0]}" /><stop offset="1" stop-color="${GRADIENT[1]}" />
  </linearGradient></defs>
  <rect width="${size}" height="${size}" rx="${rounded}" fill="${fill}" />`
    : '';
  return `<!doctype html><html><body style="margin:0">
<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  ${plate}
  ${mark({ size, scale, color })}
</svg></body></html>`;
}

const FILES = [
  // Значок приложения целиком: плитка со скруглением, как у панели в браузере.
  { name: 'icon.png', size: 1024, scale: ON_PLATE, background: 'gradient', rounded: 256 },
  // Передний план адаптивного значка — только знак, фон отдельным слоем.
  { name: 'android-icon-foreground.png', size: 1024, scale: 0.42 },
  { name: 'android-icon-background.png', size: 1024, scale: 0, background: 'gradient' },
  // Монохромный слой: система сама покрасит его в цвет темы обоев.
  { name: 'android-icon-monochrome.png', size: 1024, scale: 0.42 },
  // Заставка: знак без фона, фон задаёт `app.json`, — и он же продолжается в
  // анимации, поэтому доля стороны здесь совпадает с той, что в `AppSplash`.
  { name: 'splash-icon.png', size: 512, scale: 0.42 },
  { name: 'favicon.png', size: 128, scale: ON_PLATE, background: 'gradient', rounded: 32 },
  // Панель как приложение на компьютере: значок в панели задач и в меню «Пуск».
  {
    dir: webIcons,
    name: 'icon-192.png',
    size: 192,
    scale: ON_PLATE,
    background: 'gradient',
    rounded: 48,
  },
  {
    dir: webIcons,
    name: 'icon-512.png',
    size: 512,
    scale: ON_PLATE,
    background: 'gradient',
    rounded: 128,
  },
  // Маскируемый: плитка во весь квадрат, система сама режет её по своей форме,
  // а знак держится в безопасной середине.
  { dir: webIcons, name: 'icon-maskable-512.png', size: 512, scale: 0.42, background: 'gradient' },
  {
    dir: webIcons,
    name: 'apple-touch-icon.png',
    size: 180,
    scale: ON_PLATE,
    background: 'gradient',
  },
];

const browser = await chromium.launch();
const context = await browser.newContext({ deviceScaleFactor: 1 });
mkdirSync(assets, { recursive: true });
mkdirSync(webIcons, { recursive: true });

for (const file of FILES) {
  const tab = await context.newPage();
  await tab.setViewportSize({ width: file.size, height: file.size });
  await tab.setContent(page(file));
  const shot = await tab.screenshot({
    // Снимок всегда без фона страницы: слоям адаптивного значка нужна
    // прозрачность, а скруглённой плитке — прозрачные углы. С белым фоном
    // страницы углы значка в панели задач выходили белыми квадратиками.
    omitBackground: true,
    type: 'png',
  });
  writeFileSync(join(file.dir ?? assets, file.name), shot);
  await tab.close();
  console.log(`${file.name} — ${file.size}×${file.size}`);
}

await browser.close();
console.log('\nЗначки собраны. Чтобы они попали в приложение, нужна пересборка:');
console.log('  npx expo prebuild -p android  →  pnpm mobile:apk');
