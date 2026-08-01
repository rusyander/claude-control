/**
 * Глобальный поиск (раздел «Поиск», /search).
 *
 * Проверяет: страница открывается, до ввода — подсказка; после ввода запроса
 * идёт обращение к /api/search и показывается либо выдача, либо «ничего не
 * найдено». Гоняется по живому стенду (:8888).
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

await page.goto(`${BASE}/search`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('nav');

// До ввода — приглашение начать.
const prompt = await page.getByText('Начните вводить запрос').count();
console.log('приглашение до ввода:', prompt > 0 ? 'есть' : 'НЕТ');

// Вводим широкий запрос — он должен что-то найти в конфигурации.
const field = page.getByRole('searchbox').or(page.getByPlaceholder(/Что ищем/));
await field.first().fill('a');
await field.first().fill('git');
// `/api/search` перечитывает всю конфигурацию, поэтому ответ приходит не за
// фиксированную паузу: ждём саму выдачу, а не время.
await page
  .getByText(/Найдено:|Ничего не найдено/)
  .first()
  .waitFor({ timeout: 15000 })
  .catch(() => {});

const hasResults = await page.getByText(/Найдено:/).count();
const hasEmpty = await page.getByText('Ничего не найдено').count();
console.log(
  'после запроса «git»:',
  hasResults > 0 ? 'есть выдача' : hasEmpty > 0 ? 'пусто (валидно)' : 'НЕТ РЕАКЦИИ',
);

// Слишком короткий запрос не должен ломать состояние (возврат к приглашению).
await field.first().fill('g');
await page.waitForTimeout(600);
const backToPrompt = await page.getByText('Начните вводить запрос').count();
console.log('короткий запрос → приглашение:', backToPrompt > 0 ? 'ок' : 'нет');

const ok = prompt > 0 && (hasResults > 0 || hasEmpty > 0);
console.log(
  problems.length ? `ПРОБЛЕМЫ: ${problems.slice(0, 3).join(' | ')}` : 'ошибок консоли нет',
);
await browser.close();
process.exit(ok && problems.length === 0 ? 0 : 1);
