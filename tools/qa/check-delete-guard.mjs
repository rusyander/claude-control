/**
 * Проверка защиты от случайного удаления: кнопка подтверждения должна быть
 * заблокирована, пока имя объекта не введено дословно. Ничего не удаляет —
 * диалог закрывается по Escape.
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const BASE_URL = process.env.APP_URL ?? 'http://localhost:8888';
const OUT_DIR = join(process.cwd(), '.qa-screenshots', 'forms');
mkdirSync(OUT_DIR, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

await page.goto(`${BASE_URL}/skills`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('nav');

// Берём первый скилл в списке и открываем для него диалог удаления.
const deleteButton = page.getByRole('button', { name: /^Удалить: / }).first();
const skillName = (await deleteButton.getAttribute('aria-label'))?.replace('Удалить: ', '') ?? '';
await deleteButton.click();
await page.waitForSelector('[role="dialog"]');
await page
  .locator('[role="dialog"]')
  .evaluate((element) => Promise.all(element.getAnimations().map((a) => a.finished)));

const confirmButton = page.getByRole('button', { name: /^Удалить$/ });
const blockedInitially = await confirmButton.isDisabled();

// Неверное имя не должно разблокировать кнопку.
const input = page.locator('[role="dialog"] input').first();
await input.fill('что-то не то');
const blockedOnWrongName = await confirmButton.isDisabled();

await page.screenshot({ path: join(OUT_DIR, 'delete-guard.png') });

// Точное имя — кнопка становится доступной.
await input.fill(skillName);
const unlockedOnExactName = await confirmButton.isEnabled();

// Закрываем без удаления.
await page.keyboard.press('Escape');
await page.waitForTimeout(300);

await browser.close();

console.log('Проверяемый скилл:', skillName);
console.log('Кнопка заблокирована сразу:      ', blockedInitially ? 'да' : 'НЕТ');
console.log('Заблокирована при неверном имени:', blockedOnWrongName ? 'да' : 'НЕТ');
console.log('Разблокирована при точном имени: ', unlockedOnExactName ? 'да' : 'НЕТ');
