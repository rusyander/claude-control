/**
 * Гейт удалённого доступа на ЖИВОМ сервере: токен и источник запроса.
 *
 * Юнит `apps/server/src/lib/access-gate/access-gate.test.ts` держит решение гейта на своём
 * Fastify; здесь проверяется, что тот же гейт стоит перед настоящими маршрутами
 * запущенного сервера, отвечает понятным текстом и не мешает браузеру панели:
 *
 *  1. без токена — 401 `{"error":"Нужен токен доступа"}`; с токеном — 200 и JSON
 *     каталога; с заведомо неверным — 401 (один запрос, не перебор);
 *  2. чужой `Origin` даже с верным токеном — 403 с текстом про источник; свой
 *     источник панели — 200; запрос через прокси фронта (как у браузера) — 200.
 *
 * Ничего не пишет. Токен читается из файла панели (`api-token`); при выключенном
 * удалённом доступе проверять нечего, и прогон честно красный с причиной.
 * `API_URL` меняет адрес сервера — на адрес фронта (прокси сам подставляет
 * токен) проверка обязана покраснеть: так видно, что она умеет.
 *
 * Запуск: `node tools/qa/check-remote-gate.mjs` при поднятом `pnpm dev`.
 */
import { authHeaders } from './api-auth.mjs';

const API = process.env.API_URL ?? 'http://127.0.0.1:5178';
const WEB = process.env.APP_URL ?? 'http://localhost:8888';

const rows = [];
const check = (ok, what, detail = '') => {
  rows.push(ok);
  console.log(`${ok ? '✓' : '✗'} ${what}${detail ? ` — ${detail}` : ''}`);
};

async function call(url, headers = {}) {
  const response = await fetch(url, { headers });
  const text = await response.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { status: response.status, text, json };
}

const auth = authHeaders();
if (!auth.Authorization) {
  check(
    false,
    'удалённый доступ включён (есть файл токена)',
    'файла нет — гейт выключен, проверять нечего',
  );
  process.exit(1);
}

// 1. Токен.
const bare = await call(`${API}/api/location`);
check(bare.status === 401, 'без токена — 401', `пришло ${bare.status}`);
check(
  bare.json?.error === 'Нужен токен доступа',
  'текст отказа понятный',
  JSON.stringify(bare.json ?? bare.text.slice(0, 80)),
);

const good = await call(`${API}/api/location`, auth);
check(
  good.status === 200 && good.json && typeof good.json === 'object',
  'с токеном — 200 и JSON',
  `пришло ${good.status}`,
);

const wrong = await call(`${API}/api/location`, {
  Authorization: 'Bearer definitely-not-the-token',
});
check(wrong.status === 401, 'неверный токен — 401', `пришло ${wrong.status}`);

// 2. Источник.
const evil = await call(`${API}/api/projects`, { ...auth, Origin: 'https://evil.example' });
check(evil.status === 403, 'чужой Origin с верным токеном — 403', `пришло ${evil.status}`);
check(
  /посторонн|источник/i.test(evil.json?.error ?? ''),
  'текст отказа называет источник',
  JSON.stringify(evil.json ?? evil.text.slice(0, 80)),
);

const own = await call(`${API}/api/projects`, { ...auth, Origin: new URL(WEB).origin });
check(own.status === 200, 'свой источник панели — 200', `пришло ${own.status}`);

const viaProxy = await call(`${WEB}/api/projects`);
check(
  viaProxy.status === 200 && Array.isArray(viaProxy.json),
  'через прокси фронта (как браузер) — 200',
  `пришло ${viaProxy.status}`,
);

const failed = rows.filter((ok) => !ok).length;
console.log(
  failed ? `\nПровалено: ${failed} из ${rows.length}` : `\nВсе проверки прошли (${rows.length}).`,
);
// exitCode, а не exit(): выход посреди закрытия сокетов fetch роняет Node на
// Windows (libuv `UV_HANDLE_CLOSING`, код 127) — зелёный прогон читался бы красным.
process.exitCode = failed ? 1 : 0;
