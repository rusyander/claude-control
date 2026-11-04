/**
 * Режим «по возможности»: каждый уход мимо контура назван в шапке чата.
 *
 * Решение по контуру №4, принятое при приёмке контура: «по возможности»
 * остаётся, ТОЛЬКО пока шапка называет прямо каждый прогон, который пойдёт
 * мимо контура в облако вендора (шлюз не поднят или ключ не сохранён). Без этого
 * режим пришлось бы убрать — тихий уход данных ровно то, от чего контур защищает.
 *
 * Сервер здесь не решает ничего: план прогона (`/api/platform-run-plan/*`)
 * подменяется на лету, настройки на диске не трогаются. Шапка чата чужого CLI
 * больше не проверяется: этот чат только читает прежние разговоры (этап 10, F2c),
 * прогонов из него нет — ход чужого CLI идёт задачей ядра в `/core/chat`.
 *
 * Запуск: `node tools/qa/check-platform-bypass.mjs` при поднятом `pnpm dev`
 * (`APP_URL` — другой адрес фронта).
 */
import { chromium } from 'playwright';
import { bypassOnboarding } from './bypass-onboarding.mjs';

const BASE = process.env.APP_URL ?? 'http://localhost:8888';
const TITLE = 'Company · dev';
const RULES = { model: '', source: 'none', map: {}, catalog: [] };

let plan;
const plans = {
  gatewayDown: { routed: false, title: TITLE, reason: 'gateway_down', bypassed: true },
  noToken: { routed: false, title: TITLE, reason: 'no_token', bypassed: true },
  consumerOff: { routed: false, title: TITLE, reason: 'consumer_off' },
  refused: { routed: false, title: TITLE, reason: 'gateway_down', refused: true },
};

let bad = 0;
const check = (ok, text) => {
  console.log(`${ok ? '✓' : '✗'} ${text}`);
  if (!ok) bad += 1;
};

const json = (route, body) =>
  route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });

const browser = await chromium.launch();

async function openChat(provider) {
  const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
  await bypassOnboarding(page, { provider });
  await page.route('**/api/platform-run-plan/**', (route) =>
    json(route, { ...plan, rules: RULES, effort: true }),
  );
  return page;
}

async function headerText(provider, which) {
  plan = plans[which];
  const page = await openChat(provider);
  await page.goto(`${BASE}/chat`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('nav');
  await page.waitForTimeout(2000);
  const text = await page.locator('body').innerText();
  await page.close();
  return text;
}

// --- Свой чат (Claude) ------------------------------------------------------
const down = await headerText('claude', 'gatewayDown');
check(
  down.includes('Мимо контура') && down.includes('облако вендора'),
  'свой чат: уход мимо контура при лежащем шлюзе назван прямо',
);
check(down.includes('Поднять шлюз'), 'свой чат: сказано, что нажать, чтобы вернуть контур');

const noKey = await headerText('claude', 'noToken');
check(
  noKey.includes('Мимо контура') && noKey.includes('ключ контура не сохранён'),
  'свой чат: уход без ключа назван со своей причиной',
);

const off = await headerText('claude', 'consumerOff');
check(!off.includes('Мимо контура'), 'снятая галочка — не уход: шапка молчит');

const refused = await headerText('claude', 'refused');
check(
  !refused.includes('Мимо контура') && refused.includes('сообщение будет отклонено'),
  'обязательный контур не уходит, а отказывает — и подпись у него своя',
);

await browser.close();
console.log(bad === 0 ? '\nКаждый уход мимо контура назван.' : `\nПроблем: ${bad}`);
process.exit(bad === 0 ? 0 : 1);
