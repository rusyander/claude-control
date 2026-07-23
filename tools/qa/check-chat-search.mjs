/**
 * Поиск по чатам и по телу переписки (раздел «Чат», /chat).
 *
 * Проверяет: есть поле поиска и переключатель «По названию / По сообщениям»
 * (role=tab); переключение на «По сообщениям» меняет режим и подсказку; ввод
 * запроса в режиме сообщений обращается к /api/chat/search без падения.
 * Живой стенд (:8888).
 */
import { chromium } from 'playwright';
import { bypassOnboarding } from './bypass-onboarding.mjs';

const BASE = process.env.APP_URL ?? 'http://localhost:8888';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await bypassOnboarding(page); // убрать модалку онбординга
const problems = [];
page.on('pageerror', (e) => problems.push(e.message));
page.on('console', (m) => m.type() === 'error' && problems.push(m.text()));

await page.goto(`${BASE}/chat`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('nav');
await page.waitForTimeout(1000);

// Переключатель режима поиска — две вкладки.
const byTitle = page.getByRole('tab', { name: 'По названию' });
const byMessages = page.getByRole('tab', { name: 'По сообщениям' });
const hasTabs = (await byTitle.count()) > 0 && (await byMessages.count()) > 0;
console.log('переключатель режима поиска:', hasTabs ? 'есть' : 'НЕТ');

// Переход в режим «По сообщениям».
await byMessages.click();
await page.waitForTimeout(300);
const selected = await byMessages.getAttribute('aria-selected');
console.log('режим «По сообщениям» активен:', selected === 'true' ? 'да' : 'нет');

// Подсказка про минимум символов в режиме сообщений.
const hint = await page.getByText('Введите минимум 2 символа для поиска по переписке').count();
console.log('подсказка про минимум символов:', hint > 0 ? 'есть' : 'нет');

// Ввод запроса — обращение к /api/chat/search не должно ронять страницу.
const field = page.getByRole('searchbox').first();
await field.fill('claude');
await page.waitForTimeout(1200);
console.log('поиск по телу отработал без падения:', problems.length === 0 ? 'да' : 'НЕТ');

const ok = hasTabs && selected === 'true';
console.log(
  problems.length ? `ПРОБЛЕМЫ: ${problems.slice(0, 3).join(' | ')}` : 'ошибок консоли нет',
);
await browser.close();
process.exit(ok && problems.length === 0 ? 0 : 1);
