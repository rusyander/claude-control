/**
 * Прогон сигнала «агент ждёт человека».
 *
 * Проверяется самая хрупкая связка: признак приходит из транскрипта (то есть
 * разговор мог идти мимо панели, живого прогона за ним нет), и по нему должны
 * зажечься точка в списке чатов и метка в заголовке вкладки. Ответ гасит и то,
 * и другое.
 *
 * Список чатов подменяется на лету, а не берётся с диска: прогон обязан быть
 * воспроизводимым на любой машине, а ждущий вопрос в чужой истории — случайность.
 *
 * Звук отсюда не проверить (headless-браузер не звучит) — он покрыт юнит-тестом
 * на однократность повода.
 *
 * Запуск: `node tools/qa/check-attention.mjs` при поднятом `pnpm dev`.
 */
import { chromium } from 'playwright';
import { bypassOnboarding } from './bypass-onboarding.mjs';

const BASE = process.env.APP_URL ?? 'http://localhost:8888';
const WAITING_LABEL = 'агент ждёт ответа';

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
await bypassOnboarding(page);

let awaiting = true;
let target;

// Стоящим на вопросе объявляем один разговор — остальные оставляем как есть,
// иначе проверка «лишнего не зажглось» ничего не значит. Берём чат песочницы:
// на домашней вкладке список показывает именно их, у проектных чатов свой таб.
await page.route('**/api/chats', async (route) => {
  const response = await route.fetch();
  const chats = await response.json();
  if (Array.isArray(chats)) {
    target ??= chats.find((chat) => chat.isSandbox)?.id;
    for (const chat of chats) chat.awaitingReply = chat.id === target ? awaiting : undefined;
  }
  await route.fulfill({ response, json: chats });
});

await page.goto(`${BASE}/chat`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('nav');
await page.waitForTimeout(3000);

let bad = 0;
const check = (ok, text) => {
  console.log(`${ok ? 'ок  ' : 'ПЛОХО'} ${text}`);
  if (!ok) bad += 1;
};

if (!target) {
  console.log('В истории нет ни одного чата песочницы — списку нечего показать');
  await browser.close();
  process.exit(1);
}

const dots = page.getByRole('img', { name: WAITING_LABEL });
check((await dots.count()) === 1, 'точка «ждёт ответа» стоит ровно у одного чата');
check((await page.title()).startsWith('●'), `метка в заголовке вкладки: ${await page.title()}`);

// Человек ответил — файл больше не ждёт, сигнал обязан погаснуть сам.
awaiting = false;
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForSelector('nav');
await page.waitForTimeout(3000);

check((await dots.count()) === 0, 'после ответа точка снята');
check(!(await page.title()).startsWith('●'), 'после ответа заголовок вкладки чист');

await browser.close();
console.log(bad === 0 ? 'Сигнал ожидания работает' : `Проблем: ${bad}`);
process.exit(bad === 0 ? 0 : 1);
