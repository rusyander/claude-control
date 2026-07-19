/**
 * Проверка общего дерева файлов: один компонент должен работать и на скилле
 * (папка с вложенностью), и на скрипте (одиночный файл).
 */
import { chromium } from 'playwright';

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
const problems = [];
page.on('pageerror', (error) => problems.push(error.message));
page.on('console', (m) => m.type() === 'error' && problems.push(m.text()));
await page.emulateMedia({ colorScheme: 'dark' });

// Скилл: дерево с папками
await page.goto('http://localhost:8888/skills', { waitUntil: 'domcontentloaded' });
await page.waitForSelector('nav');
await page.waitForTimeout(2000);
await page.locator('button', { hasText: /^21 файл/ }).first().click();
await page.waitForTimeout(2000);
const skillTree = await page.getByText('references', { exact: false }).count();
console.log('скилл — папки в дереве:', skillTree > 0 ? 'есть' : 'НЕТ');
await page.screenshot({ path: '.qa-screenshots/resources-skill.png' });

// Скрипт: тот же компонент на одиночном файле
await page.goto('http://localhost:8888/scripts', { waitUntil: 'domcontentloaded' });
await page.waitForSelector('nav');
await page.waitForTimeout(1500);
await page.locator('button', { hasText: 'git-guard.mjs' }).first().click();
await page.waitForTimeout(2500);
const scriptFile = await page.getByText('git-guard.mjs').count();
console.log('скрипт — файл в дереве:', scriptFile > 1 ? 'есть' : 'НЕТ');
await page.screenshot({ path: '.qa-screenshots/resources-script.png' });

await browser.close();
console.log(problems.length ? `ПРОБЛЕМЫ: ${problems.slice(0, 3).join(' | ')}` : 'ошибок консоли нет');
