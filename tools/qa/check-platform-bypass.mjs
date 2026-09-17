/**
 * Режим «по возможности»: каждый уход мимо контура назван в шапке чата.
 *
 * Решение по контуру №4 (`docs/CONTOUR-DECISIONS.ru.md`): «по возможности»
 * остаётся, ТОЛЬКО пока шапка называет прямо каждый прогон, который пойдёт
 * мимо контура в облако вендора (шлюз не поднят или ключ не сохранён). Без этого
 * режим пришлось бы убрать — тихий уход данных ровно то, от чего контур защищает.
 *
 * Сервер здесь не решает ничего: план прогона (`/api/platform-run-plan/*`) и чат
 * чужого CLI подменяются на лету, настройки на диске не трогаются. Проверяются
 * ОБЕ шапки — своего чата и чата чужого CLI, — потому что подпись живёт в двух
 * местах, и молчание одной из них и есть тихий уход.
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
  if (provider !== 'claude') {
    const chat = {
      id: 'qa1',
      providerId: provider,
      title: 'Проверка',
      createdAt: '2026-09-17T10:00:00.000Z',
      updatedAt: '2026-09-17T10:00:00.000Z',
      messageCount: 0,
    };
    await page.route('**/api/provider-runner', (route) =>
      json(route, { providerId: provider, providerName: 'Codex', mode: 'cli' }),
    );
    await page.route('**/api/provider-chat/chats', (route) => json(route, [chat]));
    await page.route('**/api/provider-chat/chats/qa1/status', (route) =>
      json(route, { chatId: 'qa1', isRunning: false, partial: '' }),
    );
    await page.route('**/api/provider-chat/chats/qa1', (route) =>
      json(route, { ...chat, messages: [] }),
    );
  }
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

// --- Чат чужого CLI ---------------------------------------------------------
const foreign = await headerText('codex', 'gatewayDown');
check(foreign.includes('Проверка'), 'чужой чат открылся');
check(
  foreign.includes('Мимо контура') && foreign.includes('облако вендора'),
  'чужой чат: уход мимо контура назван в шапке',
);
const foreignOff = await headerText('codex', 'consumerOff');
check(!foreignOff.includes('Мимо контура'), 'чужой чат: без ухода метки нет');

await browser.close();
console.log(bad === 0 ? '\nКаждый уход мимо контура назван.' : `\nПроблем: ${bad}`);
process.exit(bad === 0 ? 0 : 1);
