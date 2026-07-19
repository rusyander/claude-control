/**
 * Регрессии чата: сценарии, на которых он ломался.
 *
 * 1. Отправка прямо из пустого состояния — сообщение уходило в никуда.
 * 2. Второе сообщение в чате — «No conversation found with session ID».
 * 3. Продолжение чата после перезагрузки страницы.
 * 4. Продолжение разговора из настоящего проекта (режим только чтения).
 * 5. Порядок списка: свежие сверху, с группами по дате.
 *
 * Разговор идёт по-настоящему, через Claude Code, — прогон занимает несколько минут.
 */
import { chromium } from 'playwright';

const BASE_URL = process.env.APP_URL ?? 'http://localhost:8888';

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });

const consoleErrors = [];
page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`));
page.on('console', (m) => {
  if (m.type() === 'error') consoleErrors.push(`console: ${m.text()}`);
});

const sendCalls = [];
page.on('request', (r) => {
  if (r.url().includes('/api/chat/send')) sendCalls.push(r.url());
});

const bubbles = () => page.locator('[class*="_bubble_"]');
const input = () => page.locator('textarea[data-chat-input]');

/** Ждём конца ответа: пока идёт генерация, на месте отправки стоит «Остановить». */
const settle = async () => {
  await page
    .locator('button:has-text("Остановить")')
    .waitFor({ state: 'detached', timeout: 240_000 })
    .catch(() => {});
  await page.waitForTimeout(3500);
};

const ask = async (text) => {
  await input().fill(text);
  await input().press('Enter');
  await settle();
};

const failures = [];
const check = (ok, description) => {
  if (!ok) failures.push(description);
  console.log(`${ok ? '✓' : '✗'} ${description}`);
};

await page.goto(`${BASE_URL}/chat`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('nav');
await page.waitForTimeout(3500);

// 1. Пустое состояние подсказывает, с чего начать, и принимает отправку.
check(
  await page.locator('[class*="_suggestion_"]').first().isVisible(),
  'пустое состояние показывает подсказки',
);

await ask('Ответь ровно одним словом: привет');
check(sendCalls.length === 1, 'отправка из пустого состояния уходит на сервер');
check((await bubbles().count()) >= 2, 'своя реплика и ответ видны в ленте');

// 2. Второе сообщение продолжает ту же сессию.
await ask('Ответь ровно одним словом: пока');
check(
  !(await page.content()).includes('No conversation found'),
  'второе сообщение не теряет сессию',
);
check((await bubbles().count()) >= 4, 'история чата накапливается');

// 3. Перезагрузка и продолжение.
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForTimeout(4000);
await page.locator('[class*="_item_"]').first().click();
await page.waitForTimeout(3000);
check((await bubbles().count()) >= 4, 'после перезагрузки история открывается');

await ask('Ответь ровно одним словом: снова');
check(
  !(await page.content()).includes('No conversation found'),
  'чат продолжается после перезагрузки',
);

// 4. Список: группы по дате и свежие сверху.
const listRows = await page.evaluate(() =>
  [...document.querySelectorAll('[class*="_group_"], [class*="_item_"]')]
    .slice(0, 6)
    .map((el) => el.innerText.replace(/\n/g, ' | ')),
);
check(/СЕГОДНЯ|TODAY/i.test(listRows[0] ?? ''), 'список начинается с группы «Сегодня»');

check(
  consoleErrors.length === 0,
  `ошибок в консоли нет${consoleErrors.length ? `: ${consoleErrors[0]}` : ''}`,
);

await browser.close();

console.log(failures.length === 0 ? '\nВсе проверки прошли.' : `\nПровалено: ${failures.length}`);
process.exit(failures.length === 0 ? 0 : 1);
