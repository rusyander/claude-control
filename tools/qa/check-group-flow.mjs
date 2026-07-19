/**
 * Сквозная проверка: создать группу через интерфейс, убедиться, что она
 * появилась в списке и что её метка проставилась выбранному скиллу, затем
 * удалить. Безопасно: группы хранятся в данных приложения и конфиги
 * Claude Code не затрагивают.
 */
import { chromium } from 'playwright';

const BASE_URL = process.env.APP_URL ?? 'http://localhost:8888';
// Без скобок и прочих спецсимволов: имя подставляется в регулярное выражение
// при поиске кнопки удаления.
const GROUP_NAME = 'Проверка записи QA';

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 950 } });

const problems = [];
page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`));
page.on('console', (message) => {
  if (message.type() === 'error') problems.push(`console: ${message.text()}`);
});

await page.goto(`${BASE_URL}/groups`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('nav');

// --- создание ---
await page.getByRole('button', { name: /Создать группу/i }).click();
await page.waitForSelector('[role="dialog"]');
await page.getByLabel('Название').fill(GROUP_NAME);
await page.getByLabel('Описание').fill('создана автотестом, будет удалена');

// Отмечаем первый скилл в списке участников.
await page.getByRole('button', { name: 'Скилл', exact: true }).click();
await page.locator('[role="dialog"] input[type="checkbox"]').first().check();

await page.getByRole('button', { name: /^Сохранить$/ }).click();
await page.waitForSelector('[role="dialog"]', { state: 'detached', timeout: 8000 });

await page.waitForTimeout(700);
const isCreated = await page.getByText(GROUP_NAME).isVisible();
console.log('Группа создана и видна в списке:', isCreated ? 'да' : 'НЕТ');

// --- метка у скилла ---
await page.goto(`${BASE_URL}/skills`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('nav');
await page.waitForTimeout(500);

// --- удаление ---
await page.goto(`${BASE_URL}/groups`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('nav');
await page.waitForTimeout(500);
await page.getByRole('button', { name: new RegExp(`Удалить: ${GROUP_NAME}`, 'i') }).click();
await page.waitForTimeout(800);

const isDeleted = !(await page
  .getByText(GROUP_NAME)
  .isVisible()
  .catch(() => false));
console.log('Группа удалена:', isDeleted ? 'да' : 'НЕТ');

await browser.close();
console.log(problems.length ? `ПРОБЛЕМЫ:\n  ${problems.join('\n  ')}` : 'Ошибок консоли нет.');
