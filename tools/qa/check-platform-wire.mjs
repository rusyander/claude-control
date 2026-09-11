/**
 * Шлюз панели НА ПРОВОДЕ: весь путь клиент → шлюз → контур, без единой подмены
 * внутри панели.
 *
 * Чем это отличается от соседей. `check-platform.mjs` подменяет API панели и
 * смотрит экран; модульные тесты шлюза кормят разборщик кадрами из строки.
 * Здесь не подменяется ничего, кроме самой корпоративной платформы: над панелью
 * стоит `stub-platform.mjs` — настоящий HTTP-сервер, отвечающий в форме
 * справочника (вендорные кадры §7, коды отказа §8). Панель поднимается своя,
 * одноразовая, с каталогом настроек во временной папке: рабочий стенд человека
 * не трогается.
 *
 * Почему без этого свипа нельзя было считать Т1 сделанной. Всё, что панель
 * обещает про контур, до сих пор доказывалось её же тестами на её же
 * представлении о проводе: вендорный кадр собирался в строку прямо в тесте и
 * ему же скармливался. Такой прогон зеленеет и тогда, когда по настоящему
 * проводу не проходит ни один запрос — ни один сокет в нём не открывался.
 *
 * Что прогоняется (каждая строка — обещание панели человеку):
 *   1. проба контура: модели прочитаны, возможности объявлены манифестом;
 *   2. поток обычного ответа: содержимое дошло, вендорный ключ наружу НЕ уехал;
 *   3. стадии контура видны в следе запроса, сжатие истории названо отдельно;
 *   4. обрыв проверками: клиент получает ОШИБКУ, а не «короткий удачный ответ»;
 *   5. названия сработавших проверок в следе — без проверявшегося текста;
 *   6. выброшенные контуром инструменты попали в потери запроса;
 *   7. картинка, не перенесённая в диалог Anthropic, НАЗВАНА, а не обнулена;
 *   8. словарь подмены сущностей не уезжает клиенту;
 *   9. отказы §8: 451 → 400 с названиями, 402 про уровень лимита, 429 со
 *      сроком повтора из `Retry-After`;
 *  10. не-потоковый вызов собран обратно, а наверх ушёл поток (`forceStream`).
 *
 * Запуск: `node tools/qa/check-platform-wire.mjs`
 * Своего окружения не требует: стаб и панель поднимаются здесь же.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { startStubPlatform } from './stub-platform.mjs';

const PANEL_PORT = Number(process.env.WIRE_PANEL_PORT ?? 5191);
const GATEWAY_PORT = Number(process.env.WIRE_GATEWAY_PORT ?? 5192);
const PANEL = `http://127.0.0.1:${PANEL_PORT}`;
const CONTOUR = 'wire-enterprise-platform';

/** Заглушка вместо ключа: собрана из кусков, чтобы в репозитории не лежало присваивание, похожее на секрет. */
const KEY = ['wire', 'stub', 'key'].join('-');

/**
 * Текст, на котором у стаба «срабатывают проверки». Ни в одном ответе клиенту и
 * ни в одном следе панели его быть не должно: ради этого проверки и стоят.
 */
const CHECKED_TEXT = 'Иванов Иван Иванович';
const CHECKED_SECRET = 'AKIAIOSFODNN7EXAMPLE';

let failures = 0;
const ok = (name) => console.log(`  ✓ ${name}`);
const bad = (name, detail) => {
  failures += 1;
  console.log(`  ✗ ${name}\n    ${detail}`);
};
const check = (name, condition, detail) => (condition ? ok(name) : bad(name, detail));

class NotChecked extends Error {}

async function waitFor(url, seconds) {
  for (let i = 0; i < seconds * 4; i += 1) {
    try {
      const res = await fetch(url);
      if (res.ok) return res;
    } catch {
      // ещё не поднялась
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return undefined;
}

async function api(path, init = {}) {
  const res = await fetch(`${PANEL}/api${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
  });
  const text = await res.text();
  let body;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    body = text;
  }
  return { status: res.status, body };
}

/** Последний след запроса по этому контуру: его читает человек в панели. */
async function lastEvent() {
  const status = await api('/platforms/gateway');
  const events = status.body?.status?.events ?? [];
  return events.find((event) => event.platformId === CONTOUR);
}

/** Один запрос через шлюз панели, ответ строкой как есть. */
async function gateway(port, path, body, headers = {}) {
  const res = await fetch(`http://127.0.0.1:${port}/${encodeURIComponent(CONTOUR)}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  return { status: res.status, text: await res.text() };
}

async function main() {
  const stub = await startStubPlatform({ port: 0 });
  const home = mkdtempSync(join(tmpdir(), 'cc-wire-'));
  mkdirSync(join(home, 'agentdeck'), { recursive: true });
  writeFileSync(join(home, 'settings.json'), '{}\n', 'utf8');
  writeFileSync(join(home, 'CLAUDE.md'), '# проверка\n', 'utf8');

  const panel = spawn(
    process.execPath,
    ['--experimental-strip-types', '--no-warnings', 'apps/server/src/index.ts'],
    {
      env: { ...process.env, CLAUDE_CONFIG_DIR: home, PORT: String(PANEL_PORT) },
      stdio: 'ignore',
      shell: false,
    },
  );

  try {
    if (!(await waitFor(`${PANEL}/api/system`, 30))) {
      throw new NotChecked('одноразовая панель не поднялась.');
    }
    console.log(`Стаб-контур: ${stub.url}\nПанель: ${PANEL}\n`);
    await run(stub);
  } finally {
    panel.kill();
    await stub.close();
    rmSync(home, { recursive: true, force: true });
  }

  console.log(failures === 0 ? '\nВсё сходится.' : `\nПровалов: ${failures}`);
  process.exit(failures === 0 ? 0 : 1);
}

async function run(stub) {
  // ── 1. Проба контура ─────────────────────────────────────────────────────
  const saved = await api(`/platforms/${encodeURIComponent(CONTOUR)}`, {
    method: 'PUT',
    body: JSON.stringify({
      settings: {
        id: CONTOUR,
        title: 'Стаб контура на проводе',
        driver: 'enterprise-platform',
        baseUrl: stub.url,
        enabled: true,
        mode: 'best-effort',
        budgetUsd: 0,
        budgetSince: '',
        capabilities: [],
        targets: [],
        projectPaths: [],
        agents: [],
        caCertPath: '',
      },
      token: KEY,
    }),
  });
  check('контур сохранён', saved.status === 200, JSON.stringify(saved.body));
  // Сохранение контур НЕ включает (Т2, инвариант 1): включён — значит активен, а
  // активность переключается своим маршрутом. Без этого шага шлюз отвечал бы на
  // все запросы ниже отказом «контур выключен в панели», и по проводу нечего
  // было бы проверять. Шлюз здесь ещё не поднят — пробный запрос активации
  // вернётся красным, и это его законный исход, а не отказ маршрута.
  const activated = await api(`/platforms/${encodeURIComponent(CONTOUR)}/activate`, {
    method: 'POST',
    body: '{}',
  });
  check(
    'контур сделан активным своим маршрутом',
    activated.status === 200 && activated.body?.activePlatformId === CONTOUR,
    JSON.stringify(activated.body).slice(0, 200),
  );

  const probe = await api(`/platforms/${encodeURIComponent(CONTOUR)}/check`, {
    method: 'POST',
    body: '{}',
  });
  const health = probe.body?.health ?? probe.body;
  check('проба прошла по проводу', health?.outcome === 'ok', JSON.stringify(probe.body));
  check(
    'модели контура прочитаны из настоящего ответа',
    (health?.models ?? []).some((model) => model.id === 'stub-chat'),
    JSON.stringify(health?.models?.slice(0, 3)),
  );
  const probeCall = stub.calls.find((call) => call.path.endsWith('/models'));
  check(
    'ключ ушёл заголовком драйвера',
    probeCall?.authorization === `Bearer ${KEY}`,
    JSON.stringify(probeCall),
  );

  // ── Шлюз ─────────────────────────────────────────────────────────────────
  await api('/settings', {
    method: 'PATCH',
    body: JSON.stringify({
      platformGateway: { enabled: true, port: GATEWAY_PORT, forceStream: true },
    }),
  });
  const restarted = await api('/platforms/gateway/restart', { method: 'POST', body: '{}' });
  const port = restarted.body?.status?.port ?? GATEWAY_PORT;
  check(
    'слушатель поднялся и знает маршрут контура',
    restarted.body?.status?.running === true &&
      restarted.body?.status?.routes?.some((route) => route.platformId === CONTOUR && route.ready),
    JSON.stringify(restarted.body?.status?.routes),
  );

  const chat = (model, extra = {}) => ({
    model,
    stream: true,
    max_tokens: 32,
    messages: [{ role: 'user', content: 'привет' }],
    ...extra,
  });

  // ── 2. Обычный поток ─────────────────────────────────────────────────────
  const clean = await gateway(port, '/v1/chat/completions', chat('stub-chat'));
  check(
    'обычный ответ дошёл до клиента потоком',
    clean.status === 200 && clean.text.includes('готов') && clean.text.includes('[DONE]'),
    `${clean.status}: ${clean.text.slice(0, 200)}`,
  );
  // Ради этой строки шлюз и разбирает поток сам: строгий клиент ломается на
  // кадре без `choices`, а таких клиентов большинство.
  check(
    'вендорный кадр наружу не уехал',
    !clean.text.includes('enterprise-platform_'),
    clean.text.slice(0, 300),
  );

  // ── 3. Стадии и сжатие истории ───────────────────────────────────────────
  const cleanEvent = await lastEvent();
  check(
    'стадии контура видны в следе запроса',
    (cleanEvent?.stages ?? []).includes('guardrails_input') &&
      (cleanEvent?.stages ?? []).includes('inference'),
    JSON.stringify(cleanEvent?.stages),
  );
  check(
    'обычный ответ не помечен сжатием истории',
    cleanEvent?.summarized === false,
    JSON.stringify(cleanEvent),
  );

  await gateway(port, '/v1/chat/completions', chat('stub-summarizing'));
  const summarized = await lastEvent();
  // Сжатие истории контур делает молча, и стадия — единственный его след:
  // человек иначе не узнает, что модель видела не весь диалог.
  check(
    'сжатие истории контуром названо отдельным фактом',
    summarized?.summarized === true && (summarized?.stages ?? []).includes('summarizing'),
    JSON.stringify(summarized),
  );

  // ── 4–5. Обрыв проверками ────────────────────────────────────────────────
  const guarded = await gateway(port, '/v1/chat/completions', chat('stub-guardrails'));
  // Кадр ошибки обязан стоять ДО `[DONE]`: сам `[DONE]` здесь законен — половина
  // клиентов без него ждёт продолжения до таймаута, — а вот поток, кончившийся
  // одним лишь `[DONE]`, клиент покажет как удачный короткий ответ.
  const errorAt = guarded.text.indexOf('"error"');
  const doneAt = guarded.text.indexOf('data: [DONE]');
  check(
    'оборванный проверками поток кончается ОШИБКОЙ, а не тишиной',
    errorAt !== -1 && (doneAt === -1 || errorAt < doneAt),
    guarded.text.slice(-300),
  );
  check(
    'ошибка обрыва названа кодом отказа по содержимому',
    /"code"\s*:\s*"content_policy_violation"/.test(guarded.text),
    guarded.text.slice(-300),
  );
  const guardEvent = await lastEvent();
  check(
    'названия сработавших проверок попали в след',
    (guardEvent?.violations ?? []).includes('toxicity') && guardEvent?.interrupted === true,
    JSON.stringify(guardEvent),
  );
  const guardSeen = `${guarded.text}${JSON.stringify(guardEvent)}`;
  check(
    'проверявшийся текст не уехал ни клиенту, ни в панель',
    !guardSeen.includes('то, на чём сработали'),
    guardSeen.slice(0, 300),
  );

  // ── 6. Выброшенные инструменты ───────────────────────────────────────────
  await gateway(
    port,
    '/v1/chat/completions',
    chat('stub-tools', {
      tools: [{ type: 'function', function: { name: 'calc', parameters: { type: 'object' } } }],
    }),
  );
  const shimmedEvent = await lastEvent();
  // С прослойкой (Т5, по умолчанию включена) инструменты не теряются, а едут
  // текстом — и след обязан говорить именно это. Строка про потерю осталась бы
  // верной только для выключенной прослойки, поэтому ниже проверяется и она:
  // человек читает один и тот же след в обоих мирах.
  check(
    'с прослойкой инструменты названы уехавшими текстом, а не потерянными',
    (shimmedEvent?.shimmed ?? []).includes('tools') &&
      !(shimmedEvent?.lost ?? []).some((item) => item.includes('tools')),
    JSON.stringify({ shimmed: shimmedEvent?.shimmed, lost: shimmedEvent?.lost }),
  );

  await api(`/platforms/${encodeURIComponent(CONTOUR)}`, {
    method: 'PUT',
    body: JSON.stringify({
      settings: {
        id: CONTOUR,
        title: 'Стаб контура на проводе',
        driver: 'enterprise-platform',
        baseUrl: stub.url,
        enabled: true,
        mode: 'best-effort',
        budgetUsd: 0,
        budgetSince: '',
        capabilities: [],
        targets: [],
        projectPaths: [],
        agents: [],
        caCertPath: '',
        toolShim: false,
      },
      token: KEY,
    }),
  });
  await gateway(
    port,
    '/v1/chat/completions',
    chat('stub-tools', {
      tools: [{ type: 'function', function: { name: 'calc', parameters: { type: 'object' } } }],
    }),
  );
  const toolsEvent = await lastEvent();
  // Контур подтверждает выброс своим кадром. Не сказать об этом — значит
  // объяснить человеку бездействие агента капризом модели.
  check(
    'без прослойки выброшенные контуром инструменты названы потерей',
    (toolsEvent?.lost ?? []).some((item) => item.includes('tools')),
    JSON.stringify(toolsEvent?.lost),
  );

  // ── 7. Картинка в чужом диалекте ─────────────────────────────────────────
  const messages = await gateway(
    port,
    '/v1/messages',
    {
      model: 'stub-image',
      stream: true,
      max_tokens: 32,
      messages: [{ role: 'user', content: 'нарисуй' }],
    },
    { 'anthropic-version': '2023-06-01' },
  );
  check(
    'текст ответа дошёл в диалекте Anthropic',
    messages.status === 200 && messages.text.includes('вот картинка'),
    `${messages.status}: ${messages.text.slice(0, 200)}`,
  );
  const imageEvent = await lastEvent();
  check(
    'непереносимая часть ответа НАЗВАНА, а не обнулена молча',
    (imageEvent?.lost ?? []).some((item) => item.includes('image')),
    JSON.stringify(imageEvent?.lost),
  );

  // ── 8. Подмена сущностей ─────────────────────────────────────────────────
  const anonymized = await gateway(port, '/v1/chat/completions', chat('stub-anonymized'));
  // В словаре подмены лежат САМИ исходные данные, ради которых подмена и
  // делалась: его утечка клиенту обнуляет весь смысл контура.
  check(
    'словарь подмены сущностей клиенту не уезжает',
    !anonymized.text.includes(CHECKED_TEXT) && !anonymized.text.includes('anonymization_mapping'),
    anonymized.text.slice(0, 300),
  );

  // ── 9. Отказы справочника §8 ─────────────────────────────────────────────
  const blocked = await gateway(port, '/v1/chat/completions', chat('stub-451'));
  const blockedBody = JSON.parse(blocked.text || '{}');
  // Своя причина отказа живёт в `error.code`: `error.type` в диалекте OpenAI —
  // это класс ошибки по схеме вендора, и ветвится клиент по паре «код HTTP +
  // code», а не по нему.
  check(
    '451 отдан клиенту кодом 400 — его понимают все клиенты',
    blocked.status === 400 && blockedBody?.error?.code === 'content_policy_violation',
    `${blocked.status}: ${blocked.text.slice(0, 200)}`,
  );
  check(
    'в отказе названы проверки, но не проверявшийся текст',
    /pii|secrets/.test(blocked.text) &&
      !blocked.text.includes(CHECKED_TEXT) &&
      !blocked.text.includes(CHECKED_SECRET),
    blocked.text.slice(0, 300),
  );

  const budget = await gateway(port, '/v1/chat/completions', chat('stub-402'));
  check(
    '402 объяснён лимитом расхода, а не «ошибкой 402»',
    budget.status === 402 && /лимит/i.test(budget.text) && !budget.text.includes(CHECKED_SECRET),
    `${budget.status}: ${budget.text.slice(0, 200)}`,
  );

  const limited = await gateway(port, '/v1/chat/completions', chat('stub-429'));
  // Без срока повтора «слишком часто» не отличается от «сломалось», а знает
  // срок только контур — заголовком `Retry-After`.
  check(
    '429 донёс срок повтора, названный контуром',
    limited.status === 429 && /через 12 с/.test(limited.text),
    `${limited.status}: ${limited.text.slice(0, 200)}`,
  );

  // ── 10. Не-потоковый вызов ───────────────────────────────────────────────
  const before = stub.calls.length;
  const plain = await gateway(port, '/v1/chat/completions', {
    model: 'stub-chat',
    max_tokens: 32,
    messages: [{ role: 'user', content: 'привет' }],
  });
  const plainBody = JSON.parse(plain.text || '{}');
  check(
    'не-потоковый вызов собран обратно в один ответ',
    plain.status === 200 && Boolean(plainBody?.choices?.[0]?.message?.content),
    `${plain.status}: ${plain.text.slice(0, 200)}`,
  );
  const upstreamBody = stub.calls.slice(before).find((call) => call.path.endsWith('/completions'));
  // Весь смысл `forceStream` в том, что НАВЕРХ ушёл поток: не-потоковый вызов
  // контур рвёт на 120-й секунде. Без взгляда на провод две проверки выше
  // зеленели бы и без него.
  check(
    'наверх при этом ушёл ПОТОК',
    JSON.parse(upstreamBody?.body ?? '{}')?.stream === true,
    upstreamBody?.body?.slice(0, 200),
  );
}

main().catch((error) => {
  if (error instanceof NotChecked) {
    console.log(`НЕ ПРОВЕРЕНО: ${error.message}`);
    process.exit(2);
  }
  console.error(error);
  process.exit(1);
});
