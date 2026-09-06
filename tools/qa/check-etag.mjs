/**
 * Условный GET списка разговоров вживую: браузер сам переспрашивает `/api/chats`
 * с `If-None-Match`, сервер отвечает 304 без тела, страница получает прежние данные.
 *
 * Ловушка, ради которой скрипт ходит через CDP, а не через `page.on('response')`:
 * при ревалидации Chromium отдаёт Playwright закэшированный ответ — `status()` = 200,
 * будто 304 не было. Настоящий код с провода лежит только в
 * `Network.responseReceivedExtraInfo.statusCode`.
 *
 * Список меняется под ногами: разговор текущей сессии панели или агента тоже в нём,
 * и его транскрипт растёт. Поэтому 200 с НОВЫМ `ETag` — законный ответ, провал —
 * только 200 с тем же `ETag`, что и у предыдущего ответа (браузер не переспросил
 * или сервер не сравнил), либо ни одного 304 на серии повторов.
 *
 * Запуск: node tools/qa/check-etag.mjs   (стенд `pnpm dev`, браузеры: pnpm qa:setup)
 */
import { chromium } from 'playwright';

const BASE = process.env.APP_URL ?? 'http://localhost:8888';
const REPEATS = 4;

const browser = await chromium.launch();
const context = await browser.newContext();
const page = await context.newPage();
const cdp = await context.newCDPSession(page);
await cdp.send('Network.enable');

const wireStatus = new Map();
const responses = [];
cdp.on('Network.responseReceivedExtraInfo', (event) =>
  wireStatus.set(event.requestId, event.statusCode),
);
cdp.on('Network.responseReceived', (event) => {
  const url = event.response.url.replace(BASE, '');
  if (url === '/api/chats')
    responses.push({ id: event.requestId, etag: event.response.headers.etag ?? '' });
});

await page.goto(`${BASE}/chat`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('nav');
await page.waitForTimeout(1500);
const listBefore = await page.locator('main').innerText();

const seenByScript = await page.evaluate(async (repeats) => {
  const out = [];
  for (let i = 0; i < repeats; i += 1) {
    const response = await fetch('/api/chats');
    const body = await response.json();
    out.push({ status: response.status, items: Array.isArray(body) ? body.length : -1 });
  }
  return out;
}, REPEATS);
await page.waitForTimeout(500);
const listAfter = await page.locator('main').innerText();
await browser.close();

let revalidated = 0;
let stale = 0;
let previousEtag = '';
for (const { id, etag } of responses) {
  const wire = wireStatus.get(id);
  const sameEtag = etag !== '' && etag === previousEtag;
  if (wire === 304) revalidated += 1;
  else if (wire === 200 && sameEtag) stale += 1;
  console.log(
    `/api/chats  на проводе=${wire}  etag=${etag.slice(0, 14)}${sameEtag && wire !== 304 ? '  ← тот же ETag, а 304 нет' : ''}`,
  );
  previousEtag = etag;
}
for (const s of seenByScript)
  console.log(`fetch со страницы: status=${s.status} элементов=${s.items}`);
const scriptOk = seenByScript.every((s) => s.status === 200 && s.items >= 0);
console.log(
  `304 на повторах: ${revalidated} из ${REPEATS}; список на экране тот же: ${listBefore === listAfter}`,
);

if (revalidated === 0 || stale > 0 || !scriptOk || listBefore !== listAfter) {
  console.log(
    'Условный GET не работает: браузер не получил 304 при том же ETag или страница увидела другой ответ.',
  );
  process.exit(1);
}
