/**
 * Прогон живой связи панели с чужим ходом агента.
 *
 * Разговор начинают не только в этом окне: с телефона, из терминала, из
 * соседней вкладки. Панель обязана узнать об этом сама — новый разговор
 * появляется в списке, переписка дописывается, — и не требовать F5. Ломалось
 * это двумя способами сразу: поток событий тихо умирал на молчащем соединении,
 * а про чужой прогон панель спрашивала сервер ровно один раз, при входе на
 * страницу.
 *
 * Ход здесь запускается МИМО браузера — прямо в API, как это делает телефон.
 * Проверяются три вещи, и все три наблюдаемы независимо от чужой истории:
 * панель переспрашивает про чужие прогоны, сервер держит поток событий живым
 * пульсом, и по факту чужого хода список разговоров перечитывается сам.
 *
 * Появление строки в боковом списке проверяется ДОПОЛНИТЕЛЬНО и только если в
 * рабочем столе открыта вкладка нужного проекта: список принадлежит вкладке, а
 * набор вкладок у каждого свой.
 *
 * Прогон настоящий: нужен установленный `claude` и живой `pnpm dev`.
 *
 * Запуск: `node tools/qa/check-live-sync.mjs`.
 */
import { chromium } from 'playwright';
import { bypassOnboarding } from './bypass-onboarding.mjs';
import { authHeaders } from './api-auth.mjs';

const BASE = process.env.APP_URL ?? 'http://localhost:8888';
const API = process.env.API_URL ?? 'http://127.0.0.1:5178';
/** Метка в тексте задачи: по ней разговор узнаётся в списке. */
const MARK = `сверка-${Date.now().toString(36)}`;

const failures = [];
const check = (ok, what) => {
  console.log(`${ok ? '✓' : '✕'} ${what}`);
  if (!ok) failures.push(what);
};

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });

/** Что страница спрашивала у сервера — по этому видно, жива ли она. */
const asked = [];
page.on('request', (request) => {
  const url = request.url();
  if (url.includes('/api/')) asked.push({ url, at: Date.now() });
});
const askedSince = (fragment, since) =>
  asked.filter((item) => item.url.includes(fragment) && item.at >= since).length;

await bypassOnboarding(page);
await page.goto(`${BASE}/chat`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('nav');
await page.waitForTimeout(2000);

// 1. Панель переспрашивает про чужие прогоны, а не спрашивает один раз при входе.
const pollStart = Date.now();
await page.waitForTimeout(12_000);
const polls = askedSince('/chat/active', pollStart);
check(polls >= 2, `панель переспрашивает про чужие прогоны (${polls} раза за 12 с)`);

// 2. Поток событий жив: сервер шлёт пульс, иначе молчащее соединение умирает
//    незаметно и панель навсегда остаётся со снимком.
const beat = await fetch(`${API}/api/events`, { headers: authHeaders() });
const reader = beat.body.getReader();
const decoder = new TextDecoder();
let pulse = '';
const until = Date.now() + 30_000;
while (Date.now() < until && !pulse.includes(': ping')) {
  const { value, done } = await reader.read();
  if (done) break;
  pulse += decoder.decode(value, { stream: true });
}
await reader.cancel();
check(pulse.includes(': ping'), 'сервер держит поток событий пульсом');

// 3. Чужой ход — и список разговоров перечитывается сам.
const tab = page.locator('[role="tab"]', { hasText: 'claude-control' }).first();
const hasTab = (await tab.count()) > 0;
if (hasTab) {
  await tab.click();
  await page.waitForTimeout(1500);
}

const runStart = Date.now();
const response = await fetch(`${API}/api/chat/send`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...authHeaders() },
  body: JSON.stringify({
    chatId: `new-${MARK}`,
    prompt: `Ответь одним словом: ок. Метка ${MARK}`,
    projectPath: process.cwd(),
  }),
});
check(response.ok, `сервер принял чужой ход (${response.status})`);
// Поток дочитываем до конца: оборванный запрос гасит и сам прогон.
await response.text();

// Страницу НЕ перезагружаем — в этом весь смысл проверки.
let refetched = false;
let appeared = false;
const deadline = Date.now() + 60_000;
while (Date.now() < deadline && !(refetched && (appeared || !hasTab))) {
  refetched ||= askedSince('/api/chats', runStart) > 0;
  if (hasTab) appeared ||= (await page.getByText(MARK).count()) > 0;
  await page.waitForTimeout(1000);
}
check(refetched, 'список разговоров перечитан без перезагрузки страницы');
if (hasTab) check(appeared, 'новый разговор виден на вкладке проекта');
else console.log('· вкладки проекта в рабочем столе нет — строку в списке не проверяем');

await browser.close();

console.log(failures.length === 0 ? '\nВсё сошлось.' : `\nНе сошлось: ${failures.length}`);
process.exit(failures.length === 0 ? 0 : 1);
