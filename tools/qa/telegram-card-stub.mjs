import { createHash } from 'node:crypto';

/**
 * Карточка Telegram «подключена» без бота (этап 12, W2-D): подмена ответов панели и ядра, чтобы
 * обходы доступности и клавиатуры и проверка гонки репозиториев видели переключатель «Отвечать
 * ядру из Telegram», поле «Репозитории для задач из Telegram» и строку «Тихие часы». Настоящие
 * настройки и статусы берутся у стенда и лишь дополняются разделом telegram — ничего не пишется:
 * подменены только чтения, а запись настройки ядра (`POST /api/core/config`) отвечает подмена с
 * судом отпечатка, как у ядра (`stale-digest`, 409). Bot API не нужен.
 */

const sha = (text) => createHash('sha256').update(text).digest('hex');
const view = (doc) => ({ doc, digest: sha(JSON.stringify(doc)), drift: null, issues: [] });

export const TELEGRAM_FINGERPRINT = 'a'.repeat(64);
export const TELEGRAM_REPOS = [{ path: 'C:/work/demo-app', baseRef: 'main' }];

const TELEGRAM_SETTINGS = {
  enabled: true,
  chatId: '424245',
  events: ['done', 'failed'],
  quiet: { from: '22:00', to: '08:00', asks: false },
};

/**
 * `state.doc` — действующая настройка ядра (запись «другой вкладки» — прямая правка его);
 * `state.configs` — тела записей окна. Возвращает состояние.
 */
export async function installTelegramCardStub(page) {
  const state = {
    doc: { telegram: { owner: TELEGRAM_FINGERPRINT, repos: TELEGRAM_REPOS } },
    configs: [],
  };
  await page.route(/\/api\/settings$/, async (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    const real = await route.fetch();
    const json = await real.json().catch(() => ({}));
    json.integrations = { ...(json.integrations ?? {}), telegram: TELEGRAM_SETTINGS };
    return route.fulfill({ response: real, json });
  });
  await page.route(/\/api\/integrations$/, async (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    const real = await route.fetch();
    const list = await real.json().catch(() => []);
    const telegram = {
      id: 'telegram',
      enabled: true,
      hasToken: true,
      maskedToken: '7000…GH',
      state: 'ok',
      detail: '',
    };
    const rest = Array.isArray(list) ? list.filter((s) => s.id !== 'telegram') : [];
    return route.fulfill({ response: real, json: [...rest, telegram] });
  });
  await page.route(/\/api\/integrations\/telegram\/answers\/core-binding$/, (route) =>
    route.fulfill({
      json: {
        fingerprint: TELEGRAM_FINGERPRINT,
        bound: true,
        reachable: true,
        ownerName: 'QA',
        listening: true,
      },
    }),
  );
  await page.route(/\/api\/core\/(config|nonce)(\?|$)/, async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace(/^\/api\/core/, '');
    if (path === '/nonce') {
      return route.fulfill({
        json: { nonce: 'qa-telegram-nonce', expiresAt: Date.now() + 60_000 },
      });
    }
    if (request.method() === 'GET') return route.fulfill({ json: view(state.doc) });
    const body = request.postDataJSON();
    state.configs.push(body);
    if (body?.baseDigest !== view(state.doc).digest) {
      return route.fulfill({
        status: 409,
        json: {
          error: 'Настройку уже изменили: перечитайте и повторите',
          code: 'stale-digest',
          digest: view(state.doc).digest,
        },
      });
    }
    state.doc = body.doc;
    return route.fulfill({ json: { view: view(state.doc), replayed: false, warnings: [] } });
  });
  return state;
}
