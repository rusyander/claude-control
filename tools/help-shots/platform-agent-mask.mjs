/**
 * Временная заплатка кадра platform/agent/01-chat-run (ru, en): закрыть в ПИКСЕЛЯХ то, что кадр
 * снят до переименования и до закрытия марки.
 *
 * Зачем существует. Кадр снят на живом стенде платформы компании с моделью qwen2.5:0.5b, и в нём
 * остались имя стенда со словом марки (подпись под выбором модели) и старое имя панели в шапке
 * боковой панели. Переснять нельзя без живой модели: история кадра — «полмиллиарда параметров не
 * делают вызов», а ключ стенда сейчас выдаёт только 7b. До пересъёмки (вопрос владельцу) кадр
 * чинится здесь, повторяемо: фиксированный прямоугольник на кадр, залитый фоном, взятым из самого
 * кадра, и поверх — тот же текст, который подставил бы кит (`brand-mask.mjs` закрывает марку в
 * разметке ДО снимка, а здесь разметки уже нет): шрифт и кегль панели, цвет текста из кадра.
 * Название стенда — как на кадрах activate: «Платформа компании · стенд» / «Company · stand».
 *
 * Запуск: `node tools/help-shots/platform-agent-mask.mjs` — переписывает оба PNG на месте; повторный
 * запуск даёт тот же кадр (прямоугольник закрывает и прошлую заплатку). После пересъёмки ×4 на живой
 * модели этот файл удаляется вместе с записью о нём.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';
import { restampFrame } from './kit.mjs';

const DIR = join(resolve(import.meta.dirname, '../..'), 'apps/web/public/help/platform/agent');
// Шрифт панели (global.scss --font-sans): Inter в системе нет — браузер берёт Segoe UI, как и при снимке.
const FONT =
  "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', sans-serif";

// Прямоугольники в пикселях кадра 1280×1000. bgAt — точка внутри прямоугольника без текста (фон),
// inkAt — прямоугольник, где самый тёмный пиксель и есть цвет текста.
const brand = {
  rect: { x: 48, y: 22, w: 190, h: 38 },
  bgAt: [230, 26],
  // Заголовок боковой панели: heading-sm, 18px / 1.25, 600; середина строки — y 40, как на свежих кадрах.
  box: { left: 56, top: 29, css: 'font-size:18px;line-height:22.5px;font-weight:600' },
  lines: ['AgentDeck'],
};

const FRAMES = [
  {
    file: '01-chat-run.png',
    patches: [
      { ...brand, inkAt: { x: 56, y: 30, w: 120, h: 20 } },
      {
        rect: { x: 700, y: 103, w: 352, h: 60 },
        bgAt: [1040, 160],
        inkAt: { x: 706, y: 106, w: 200, h: 14 },
        // Подсказка под выбором модели: caption 12px / 18px, колонка 44ch от 14px, зазор 2px.
        box: { left: 706, top: 104, css: 'font-size:14px;max-width:44ch' },
        caption: true,
        lines: [
          'Через контур «Платформа компании · стенд»: qwen2.5:0.5b.',
          'Контур «Платформа компании · стенд» не принимает глубину продумывания — она не отправляется.',
        ],
      },
    ],
  },
  {
    file: '01-chat-run.en.png',
    patches: [
      { ...brand, inkAt: { x: 56, y: 30, w: 120, h: 20 } },
      {
        rect: { x: 698, y: 103, w: 352, h: 60 },
        bgAt: [1040, 160],
        inkAt: { x: 703, y: 106, w: 200, h: 14 },
        box: { left: 703, top: 104, css: 'font-size:14px;max-width:44ch' },
        caption: true,
        lines: [
          'Through the "Company · stand" contour: qwen2.5:0.5b.',
          'The "Company · stand" contour takes no reasoning effort — it is not sent.',
        ],
      },
    ],
  },
];

const html = (dataUrl) => `<!doctype html><html><head><meta charset="utf-8"><style>
  html,body{margin:0;padding:0;background:#fff}
  #shot{position:relative;width:1280px;height:1000px;font-family:${FONT}}
  #shot img{position:absolute;left:0;top:0}
  .rect,.box{position:absolute}
  .cap{display:block;font-size:12px;line-height:18px}
  .cap+.cap{margin-top:2px}
</style></head><body><div id="shot"><img src="${dataUrl}"></div></body></html>`;

const browser = await chromium.launch();
try {
  const page = await browser.newPage({
    viewport: { width: 1280, height: 1000 },
    deviceScaleFactor: 1,
  });
  for (const frame of FRAMES) {
    const path = join(DIR, frame.file);
    await page.setContent(html(`data:image/png;base64,${readFileSync(path).toString('base64')}`));
    await page.waitForFunction(() => document.querySelector('#shot img').complete);
    await page.evaluate((patches) => {
      const img = document.querySelector('#shot img');
      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0);
      const px = (x, y) => ctx.getImageData(x, y, 1, 1).data;
      const rgb = (d) => `rgb(${d[0]},${d[1]},${d[2]})`;
      const shot = document.querySelector('#shot');
      for (const p of patches) {
        // Цвет текста — самый тёмный пиксель старой надписи: кадр сам говорит, какой у него muted/fg.
        const ink = ctx.getImageData(p.inkAt.x, p.inkAt.y, p.inkAt.w, p.inkAt.h).data;
        let best = [0, 0, 0, 1e9];
        for (let i = 0; i < ink.length; i += 4) {
          const sum = ink[i] + ink[i + 1] + ink[i + 2];
          if (sum < best[3]) best = [ink[i], ink[i + 1], ink[i + 2], sum];
        }
        const rect = document.createElement('div');
        rect.className = 'rect';
        Object.assign(rect.style, {
          left: `${p.rect.x}px`,
          top: `${p.rect.y}px`,
          width: `${p.rect.w}px`,
          height: `${p.rect.h}px`,
          background: rgb(px(p.bgAt[0], p.bgAt[1])),
        });
        const box = document.createElement('div');
        box.className = 'box';
        box.style.cssText = `left:${p.box.left}px;top:${p.box.top}px;color:${rgb(best)};${p.box.css}`;
        for (const line of p.lines) {
          const span = document.createElement('span');
          if (p.caption) span.className = 'cap';
          span.textContent = line;
          box.appendChild(span);
        }
        shot.append(rect, box);
      }
    }, frame.patches);
    const png = await page.locator('#shot').screenshot({ type: 'png' });
    writeFileSync(path, png);
    // Картинка изменилась после снимка — печать кадра ставится заново через кит, с проверкой, что
    // нарисованные строки есть в тексте описи (сторож `check-help-shots` сверяет обе половины).
    restampFrame(DIR, frame.file, { painted: frame.patches.flatMap((patch) => patch.lines) });
    console.log(`закрыто: ${frame.file} (${frame.patches.length} заплатки)`);
  }
} finally {
  await browser.close();
}
