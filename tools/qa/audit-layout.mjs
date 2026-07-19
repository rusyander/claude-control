/**
 * Аудит вёрстки: ищет то, что видно глазом, но не ловится типами —
 * горизонтальное переполнение, элементы вплотную к краю, слишком широкие
 * блоки текста и обрезанный контент.
 */
import { chromium } from 'playwright';

const BASE_URL = process.env.APP_URL ?? 'http://localhost:8888';

const ROUTES = [
  ['Обзор', '/'],
  ['Аналитика', '/analytics'],
  ['Правила', '/rules'],
  ['Скиллы', '/skills'],
  ['Хуки', '/hooks'],
  ['Плагины', '/plugins'],
  ['MCP', '/mcp'],
  ['Права', '/permissions'],
  ['Переменные', '/env'],
  ['Группы', '/groups'],
  ['Настройки', '/settings'],
  ['Справка', '/help'],
];

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const problems = [];

for (const [name, path] of ROUTES) {
  await page.goto(`${BASE_URL}${path}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('nav');
  await page.waitForTimeout(900);

  const report = await page.evaluate(() => {
    const issues = [];
    const main = document.querySelector('main');
    if (!main) return issues;

    // Горизонтальная прокрутка страницы — почти всегда ошибка вёрстки.
    if (document.documentElement.scrollWidth > document.documentElement.clientWidth + 1) {
      issues.push(
        `страница шире окна на ${document.documentElement.scrollWidth - document.documentElement.clientWidth}px`,
      );
    }

    const mainRect = main.getBoundingClientRect();

    for (const element of main.querySelectorAll('*')) {
      const rect = element.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;

      // Элемент вылезает за правую границу области контента.
      if (rect.right > mainRect.right + 1) {
        const tag = element.tagName.toLowerCase();
        const cls = String(element.className).slice(0, 40);
        issues.push(
          `выходит за правый край: ${tag}.${cls} (+${Math.round(rect.right - mainRect.right)}px)`,
        );
      }
    }

    // Слишком длинная строка текста читается плохо: ориентир — около 90 символов.
    for (const element of main.querySelectorAll('p, span')) {
      const rect = element.getBoundingClientRect();
      const text = element.textContent ?? '';
      if (text.length > 120 && rect.width > 900) {
        issues.push(`слишком широкий текст (${Math.round(rect.width)}px): «${text.slice(0, 45)}…»`);
      }
    }

    return [...new Set(issues)];
  });

  if (report.length > 0) {
    problems.push(`\n[${name}]`);
    for (const issue of report.slice(0, 6)) problems.push(`  · ${issue}`);
  }
}

await browser.close();

console.log(problems.length ? problems.join('\n') : 'Проблем вёрстки не найдено.');
