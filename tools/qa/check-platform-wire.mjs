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
 *   9. отказы §8: 451 → 400 с названиями, 402 про бюджет ключа, 429 со
 *      сроком повтора из `Retry-After`;
 *  10. не-потоковый вызов собран обратно, а наверх ушёл поток (`forceStream`);
 *  11. правила контура и матрица конфликтов — из ответа ЖИВОЙ панели, включая
 *      запись, настроенную до Т7 (поля `rules` в ней нет вовсе), и отказ на
 *      сохранении противоречия. Экранный свип подменяет этот ответ и потому
 *      доказывает только отрисовку — сервер в нём не участвует (ревью Т7, M4);
 *  12. кадры живого контура: итоговый текст, заменяющий поток, ошибка объектом
 *      после заголовков 200, хвост вызова после причины остановки; расход из
 *      кадра с непустым `choices` (проверен в шаге 3).
 *  13. эталонный драйвер `openai-compat`: нативные инструменты полем в обоих
 *      диалектах клиента, поля OpenAI без потерь, общие отказы без текстов
 *      платформа компании; им же идут разделы шлюзов Azure, Together и OpenRouter.
 *
 * Запуск: `node tools/qa/check-platform-wire.mjs`
 * Своего окружения не требует: стаб и панель поднимаются здесь же.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { REWRITTEN_FINAL, startStubPlatform } from './stub-platform.mjs';

const PANEL_PORT = Number(process.env.WIRE_PANEL_PORT ?? 5191);
const GATEWAY_PORT = Number(process.env.WIRE_GATEWAY_PORT ?? 5192);
const PANEL = `http://127.0.0.1:${PANEL_PORT}`;
const CONTOUR = 'wire-enterprise-platform';
/** Контур, настроенный ДО Т7: запись в `state.json` без поля `rules` вовсе. */
const LEGACY = 'wire-legacy';

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
  // Запись контура, какой её оставила панель ДО Т7: ни `rules`, ни полей Т6.
  // Пишется мимо API нарочно — двери записи заполняют умолчания сами, и через
  // них этот класс дефекта воспроизвести нельзя в принципе.
  writeFileSync(
    join(home, 'agentdeck', 'state.json'),
    `${JSON.stringify({
      settings: {
        platforms: [
          {
            id: LEGACY,
            title: 'Контур, настроенный до Т7',
            driver: 'enterprise-platform',
            baseUrl: 'https://api.example.ru',
            enabled: false,
            mode: 'best-effort',
            budgetUsd: 0,
            capabilities: [],
            targets: [],
            projectPaths: [],
            caCertPath: '',
          },
        ],
      },
    })}\n`,
    'utf8',
  );

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
  // Расход контур шлёт кадром с НЕпустым `choices`. Разбор ждал пустого и на
  // живом контуре писал в журнал ноль токенов при зелёном стабе (13.09.2026).
  check(
    'расход из кадра с ответом дошёл до журнала',
    cleanEvent?.totalTokens === 13,
    JSON.stringify({ totalTokens: cleanEvent?.totalTokens }),
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
    (guardEvent?.violations ?? []).includes('Токсичность') && guardEvent?.interrupted === true,
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
    // Название правила от администратора, а без него — тип правила.
    blocked.text.includes('Персональные данные') &&
      blocked.text.includes('SECRETS') &&
      !blocked.text.includes(CHECKED_TEXT) &&
      !blocked.text.includes(CHECKED_SECRET),
    blocked.text.slice(0, 300),
  );

  const budget = await gateway(port, '/v1/chat/completions', chat('stub-402'));
  check(
    '402 назван бюджетом ключа, а не «ошибкой 402» и не чужим лимитом',
    budget.status === 402 &&
      /исчерпан бюджет ключа/i.test(budget.text) &&
      !budget.text.includes('не бюджет ключа') &&
      !budget.text.includes(CHECKED_SECRET),
    `${budget.status}: ${budget.text.slice(0, 200)}`,
  );
  // Из тела 402 манифест enterprise-platform читает, ЧЕЙ это лимит, — до экрана.
  const spend = await api(`/platforms/${CONTOUR}/spend`);
  check(
    'учёт знает, что кончился именно бюджет ключа',
    spend.body?.budget?.exhausted === true && spend.body?.budget?.exhaustedScope === 'key',
    JSON.stringify(spend.body?.budget ?? spend.status),
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

  // ── 12. Кадры, которые шлёт живой контур, а не справочник ─────────────────
  //
  // Итоговый текст, заменяющий отданный поток. Клиент без потока получает ТОТ
  // текст, который платформа признала ответом, а след говорит о расхождении:
  // потоковый клиент его уже прочитал другим.
  const rewritten = await gateway(port, '/v1/chat/completions', {
    model: 'stub-rewritten',
    max_tokens: 32,
    messages: [{ role: 'user', content: 'куда писать?' }],
  });
  const rewrittenBody = JSON.parse(rewritten.text || '{}');
  check(
    'цельный ответ несёт итоговый текст контура, а не отданный поток',
    rewrittenBody?.choices?.[0]?.message?.content === REWRITTEN_FINAL,
    `${rewritten.status}: ${rewritten.text.slice(0, 200)}`,
  );
  check(
    'расхождение потока с итоговым текстом названо в следе',
    (await lastEvent())?.rewritten === 'diverged',
    JSON.stringify(await lastEvent()),
  );

  // Отказ поставщика объектом `error` после заголовков 200.
  const failedWhole = await gateway(port, '/v1/chat/completions', {
    model: 'stub-stream-error',
    max_tokens: 32,
    messages: [{ role: 'user', content: 'привет' }],
  });
  check(
    'ошибка кадром посреди потока — код отказа и причина контура, а не пустой успех',
    failedWhole.status === 429 && failedWhole.text.includes('Лимит запросов модели исчерпан'),
    `${failedWhole.status}: ${failedWhole.text.slice(0, 200)}`,
  );
  const failedEvent = await lastEvent();
  check(
    'такой отказ записан в след своим кодом и причиной',
    failedEvent?.status === 429 && /Лимит запросов/.test(failedEvent?.error ?? ''),
    JSON.stringify({ status: failedEvent?.status, error: failedEvent?.error }),
  );
  const failedStream = await gateway(port, '/v1/chat/completions', chat('stub-stream-error'));
  check(
    'потоковый клиент получает терминальную ошибку, а не причину остановки',
    failedStream.text.includes('rate_limit_error') &&
      !failedStream.text.includes('"finish_reason":"stop"'),
    failedStream.text.slice(-300),
  );

  // Хвост вызова после причины остановки. Прослойку включаем обратно: шаг 6
  // выключил её, чтобы проверить потерю инструментов.
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
        toolShim: true,
      },
      token: KEY,
    }),
  });
  const tail = await gateway(
    port,
    '/v1/chat/completions',
    chat('stub-tool-tail', {
      stream_options: { include_usage: true },
      tools: [{ type: 'function', function: { name: 'Write', parameters: { type: 'object' } } }],
    }),
  );
  check(
    'вызов, дописанный после причины остановки, доведён до клиента',
    /"tool_calls"/.test(tail.text) &&
      tail.text.includes('tail.txt') &&
      /"finish_reason":"tool_calls"/.test(tail.text) &&
      !tail.text.includes('<tool_call>'),
    tail.text.slice(-400),
  );
  check(
    'кадр расхода идёт после кадра завершения',
    tail.text.includes('"total_tokens":13') &&
      tail.text.lastIndexOf('"finish_reason":"tool_calls"') < tail.text.lastIndexOf('"usage"'),
    tail.text.slice(-400),
  );

  // ── 11. Правила контура: НАСТОЯЩИЙ сервер, а не сочинённый ответ ─────────
  //
  // Экранный свип (`check-platform.mjs`) подменяет `/api/platforms` и потому
  // доказывает только «карточка рисует присланное». Здесь тот же список
  // приходит от живой панели, вместе с записью контура, у которой поля `rules`
  // нет вовсе (её положили в `state.json` до старта): ровно она роняла весь
  // раздел «Контур» пятисотым и каждый прогон шлюза — 502 (ревью Т7, B1/M4).
  const listed = await api('/platforms');
  check(
    'список контуров отвечает, хотя одна запись настроена ДО Т7',
    listed.status === 200 && Array.isArray(listed.body?.platforms),
    `${listed.status}: ${JSON.stringify(listed.body).slice(0, 200)}`,
  );
  const legacy = (listed.body?.platforms ?? []).find((row) => row.platform?.id === LEGACY);
  check(
    'у записи без правил они подставлены умолчанием, а не отсутствуют',
    Array.isArray(legacy?.platform?.rules?.platform?.platformTools) &&
      legacy?.platform?.rules?.platform?.toolMode === 'loop',
    JSON.stringify(legacy?.platform?.rules),
  );
  const wired = (listed.body?.platforms ?? []).find((row) => row.platform?.id === CONTOUR);
  // Список правил и матрица приезжают ОДНИМ модулем сервера: расхождение
  // «на экране одно, на проводе другое» ловится только здесь.
  const managedIds = (wired?.rules ?? []).filter((row) => row.field).map((row) => row.id);
  check(
    'правила контура пришли от сервера списком манифеста',
    managedIds.join(',') === 'enterprise-platform_tools,enterprise-platform_tool_mode,generation_preset,enable_thinking',
    JSON.stringify(managedIds),
  );
  check(
    'видимое правило названо вместе с местом, где им распоряжаются',
    (wired?.rules ?? []).some((row) => row.id === 'guardrails' && row.where),
    JSON.stringify((wired?.rules ?? []).filter((row) => !row.field)),
  );
  const exclusive = (wired?.conflicts ?? []).find((row) => row.id === 'tools');
  check(
    'взаимное исключение названо сервером и сейчас НЕ нарушено',
    exclusive?.level === 'exclusive' && exclusive?.active === false,
    JSON.stringify(wired?.conflicts),
  );

  // Та же дверь, что и у человека: панель обязана ОТКАЗАТЬ, а не тихо выключить
  // прослойку, — и отказ обязан назвать обе стороны. Карточки нет — значит выше
  // уже всё красное, и падать стеком вместо строки не за чем.
  const contradiction = wired?.platform
    ? await api(`/platforms/${encodeURIComponent(CONTOUR)}`, {
        method: 'PUT',
        body: JSON.stringify({
          settings: {
            ...wired.platform,
            toolShim: true,
            rules: {
              platform: { ...wired.platform.rules.platform, platformTools: ['web_search'] },
            },
          },
        }),
      })
    : { status: 0, body: 'карточка контура не пришла' };
  check(
    'сохранение противоречия отклонено настоящим маршрутом',
    contradiction.status === 400 && /Включить оба нельзя/.test(JSON.stringify(contradiction.body)),
    `${contradiction.status}: ${JSON.stringify(contradiction.body).slice(0, 200)}`,
  );

  // `single_turn` через настоящий сокет: контур (как router.py) отвергает его с
  // потоком, поэтому ход обязан уйти наверх цельным, а клиенту Anthropic —
  // приехать потоком с блоком вызова. Тем же ходом — размышления «выключить»:
  // PUT проходит настоящую схему настроек и хранилище, а поле контура вложенное
  // (`chat/schemas.py:120`), верхнее `enable_thinking` он выбрасывает молча.
  if (wired?.platform) {
    await api(`/platforms/${encodeURIComponent(CONTOUR)}`, {
      method: 'PUT',
      body: JSON.stringify({
        settings: {
          ...wired.platform,
          toolShim: false,
          rules: {
            platform: {
              ...wired.platform.rules.platform,
              platformTools: ['web_search'],
              toolMode: 'single_turn',
              enableThinking: 'off',
            },
          },
        },
      }),
    });
  }
  const singleBefore = stub.calls.length;
  const single = await gateway(port, '/v1/messages', {
    model: 'stub-chat',
    max_tokens: 64,
    stream: true,
    messages: [{ role: 'user', content: 'какая погода?' }],
  });
  const singleUp = stub.calls
    .slice(singleBefore)
    .find((call) => call.path.endsWith('/chat/completions'));
  const singleSent = JSON.parse(singleUp?.body ?? '{}');
  check(
    'single_turn ушёл к контуру НЕ потоком',
    singleSent.enterprise-platform_tool_mode === 'single_turn' && singleSent.stream !== true,
    JSON.stringify({ mode: singleSent.enterprise-platform_tool_mode, stream: singleSent.stream }),
  );
  check(
    '«выключить размышления» ушло вложенным false, а не верхним полем',
    singleSent.chat_template_kwargs?.enable_thinking === false &&
      !('enable_thinking' in singleSent),
    JSON.stringify({
      kwargs: singleSent.chat_template_kwargs,
      top: singleSent.enable_thinking,
    }),
  );
  check(
    'вызов контура доехал до клиента Anthropic блоком tool_use в потоке',
    single.status === 200 &&
      single.text.includes('"type":"tool_use"') &&
      single.text.includes('"name":"web_search"') &&
      single.text.includes('"stop_reason":"tool_use"'),
    `${single.status}: ${single.text.slice(0, 300)}`,
  );

  // ── 13. Эталонный драйвер `openai-compat` на проводе (DRV-15) ────────────
  // Все разделы выше идут драйвером enterprise-platform, и эталонный драйвер — тот, которым
  // подключается любой совместимый шлюз, — до этой задачи не проходил по сокету
  // ни разу: его нативные инструменты, общие отказы и отсутствие вендорных полей
  // доказывались только модульными тестами. Проверяется то, что стаб ПОЛУЧИЛ.
  const compat = await api(`/platforms/${encodeURIComponent(CONTOUR)}`, {
    method: 'PUT',
    body: JSON.stringify({
      settings: {
        ...wired.platform,
        driver: 'openai-compat',
        baseUrl: stub.url,
        toolShim: false,
        rules: {
          ...wired.platform.rules,
          platform: { ...wired.platform.rules.platform, platformTools: [], toolMode: 'loop' },
        },
      },
      token: KEY,
    }),
  });
  check(
    'контур переведён на эталонный драйвер',
    compat.status === 200,
    JSON.stringify(compat.body).slice(0, 300),
  );
  const compatProbe = await api(`/platforms/${encodeURIComponent(CONTOUR)}/check`, {
    method: 'POST',
    body: '{}',
  });
  const compatHealth = compatProbe.body?.health ?? compatProbe.body;
  check(
    'openai-compat: проба прошла и прочла каталог',
    compatHealth?.outcome === 'ok' &&
      (compatHealth.models ?? []).some((model) => model.id === 'stub-chat'),
    JSON.stringify({ outcome: compatHealth?.outcome, detail: compatHealth?.detail }),
  );

  const writeTool = {
    type: 'function',
    function: {
      name: 'Write',
      description: 'пишет файл',
      parameters: { type: 'object', properties: { file_path: { type: 'string' } } },
    },
  };
  const compatBefore = stub.calls.length;
  const nativeOpenAi = await gateway(port, '/v1/chat/completions', {
    ...chat('stub-tool-native'),
    tools: [writeTool],
    tool_choice: 'auto',
    seed: 7,
    response_format: { type: 'text' },
  });
  const nativeSent = stub.calls
    .slice(compatBefore)
    .find((call) => call.path.endsWith('/chat/completions'));
  const nativeBody = JSON.parse(nativeSent?.body ?? '{}');
  check(
    'openai-compat: инструменты, выбор, seed и формат ответа ушли полями как есть',
    nativeBody.tools?.[0]?.function?.name === 'Write' &&
      nativeBody.tool_choice === 'auto' &&
      nativeBody.seed === 7 &&
      nativeBody.response_format?.type === 'text',
    JSON.stringify({ ...nativeBody, messages: undefined }).slice(0, 400),
  );
  check(
    'openai-compat: ни вендорного поля, ни протокола прослойки в теле',
    Object.keys(nativeBody).every((key) => !key.startsWith('enterprise-platform_')) &&
      !String(nativeSent?.body ?? '').includes('tool_call>'),
    Object.keys(nativeBody).join(','),
  );
  check(
    'openai-compat: ключ ушёл Bearer, вызов модели дошёл клиенту полем',
    nativeSent?.authorization === `Bearer ${KEY}` &&
      nativeOpenAi.status === 200 &&
      nativeOpenAi.text.includes('"tool_calls"') &&
      nativeOpenAi.text.includes('Write'),
    `${nativeOpenAi.status}: ${nativeOpenAi.text.slice(0, 300)}`,
  );
  const nativeEvent = await lastEvent();
  check(
    'openai-compat: след без потерь, вызов назван нативным',
    nativeEvent?.status === 200 &&
      (nativeEvent.lost ?? []).length === 0 &&
      nativeEvent.nativeCalls === 1 &&
      nativeEvent.contourCalls === 0,
    JSON.stringify(nativeEvent),
  );

  const bridgedBefore = stub.calls.length;
  const nativeAnthropic = await gateway(
    port,
    '/v1/messages',
    {
      model: 'stub-tool-native',
      max_tokens: 64,
      stream: true,
      tools: [
        { name: 'Write', description: 'пишет файл', input_schema: writeTool.function.parameters },
      ],
      messages: [{ role: 'user', content: 'запиши файл' }],
    },
    { 'anthropic-version': '2023-06-01' },
  );
  const bridgedBody = JSON.parse(
    stub.calls.slice(bridgedBefore).find((call) => call.path.endsWith('/chat/completions'))?.body ??
      '{}',
  );
  check(
    'openai-compat: клиент Anthropic — инструменты переведены в поле OpenAI, а не потеряны',
    bridgedBody.tools?.[0]?.function?.name === 'Write' &&
      nativeAnthropic.status === 200 &&
      nativeAnthropic.text.includes('"tool_use"') &&
      nativeAnthropic.text.includes('"Write"'),
    `${nativeAnthropic.status}: ${nativeAnthropic.text.slice(0, 300)}`,
  );

  const compat401 = await gateway(port, '/v1/chat/completions', chat('stub-401'));
  check(
    'openai-compat: 401 общими словами, без пяти причин платформа компании',
    compat401.status === 401 &&
      compat401.text.includes('Проверьте сам ключ') &&
      !compat401.text.includes('истёк по сроку'),
    `${compat401.status}: ${compat401.text.slice(0, 300)}`,
  );
  const compat429 = await gateway(port, '/v1/chat/completions', chat('stub-429'));
  check(
    'openai-compat: 429 со сроком повтора из заголовка шлюза',
    compat429.status === 429 && compat429.text.includes('12'),
    `${compat429.status}: ${compat429.text.slice(0, 300)}`,
  );

  // ── Пресеты и переопределения на проводе (DRV-03) ────────────────────────
  // Пресет — драйвер данными: что он объявил, должно менять то, КУДА и ЧТО
  // уходит из сокета. vLLM объявляет родную ручку Anthropic и поле размышлений,
  // Azure — ключ в `api-key`; переопределение контура снимает объявленное.
  const presetPut = (settings) =>
    api(`/platforms/${encodeURIComponent(CONTOUR)}`, {
      method: 'PUT',
      body: JSON.stringify({
        settings: {
          ...wired.platform,
          baseUrl: stub.url,
          toolShim: false,
          ...settings,
          rules: {
            ...wired.platform.rules,
            platform: {
              ...wired.platform.rules.platform,
              platformTools: [],
              toolMode: 'loop',
              enableThinking: 'on',
            },
          },
        },
        token: KEY,
      }),
    });
  const anthropicTurn = (stream) =>
    gateway(
      port,
      '/v1/messages',
      {
        model: 'stub-chat',
        max_tokens: 64,
        stream,
        tools: [
          { name: 'Write', description: 'пишет файл', input_schema: writeTool.function.parameters },
        ],
        messages: [{ role: 'user', content: 'привет' }],
      },
      { 'anthropic-version': '2023-06-01' },
    );

  const vllm = await presetPut({ driver: 'vllm' });
  check('контур переведён на пресет vLLM', vllm.status === 200, JSON.stringify(vllm.body));
  for (const stream of [false, true]) {
    const before = stub.calls.length;
    const turn = await anthropicTurn(stream);
    const sent = stub.calls.slice(before);
    const native = sent.find((call) => call.path === '/v1/messages');
    const nativeBody = JSON.parse(native?.body ?? '{}');
    check(
      `vLLM (${stream ? 'поток' : 'цельно'}): клиент Anthropic дошёл до родной /v1/messages, моста не было`,
      native !== undefined &&
        !sent.some((call) => call.path.endsWith('/chat/completions')) &&
        nativeBody.tools?.[0]?.input_schema !== undefined &&
        native.anthropicVersion === '2023-06-01' &&
        native.authorization === `Bearer ${KEY}` &&
        turn.status === 200 &&
        turn.text.includes('ответ родной ручки'),
      JSON.stringify({
        paths: sent.map((call) => call.path),
        status: turn.status,
        text: turn.text.slice(0, 200),
      }),
    );
  }
  const vllmChatBefore = stub.calls.length;
  await gateway(port, '/v1/chat/completions', chat('stub-chat'));
  const vllmChat = JSON.parse(
    stub.calls.slice(vllmChatBefore).find((call) => call.path.endsWith('/chat/completions'))
      ?.body ?? '{}',
  );
  check(
    'vLLM: размышления ушли полем пресета chat_template_kwargs.enable_thinking',
    vllmChat.chat_template_kwargs?.enable_thinking === true &&
      vllmChat.enable_thinking === undefined,
    JSON.stringify({ ...vllmChat, messages: undefined }).slice(0, 300),
  );

  const overridden = await presetPut({
    driver: 'vllm',
    manifest: { anthropicMessages: '', thinkingField: 'enable_thinking' },
  });
  check(
    'переопределения контура сохранены и прочитаны обратно',
    overridden.status === 200 &&
      JSON.stringify(overridden.body?.platform?.manifest ?? overridden.body?.manifest) ===
        JSON.stringify({ anthropicMessages: '', thinkingField: 'enable_thinking' }),
    JSON.stringify(overridden.body).slice(0, 400),
  );
  const bridgeBefore = stub.calls.length;
  const bridged = await anthropicTurn(false);
  const bridgeSent = stub.calls.slice(bridgeBefore);
  const bridgeBody = JSON.parse(
    bridgeSent.find((call) => call.path.endsWith('/chat/completions'))?.body ?? '{}',
  );
  check(
    'vLLM с «ручки нет»: клиент Anthropic пошёл мостом, поле размышлений — переопределённое',
    !bridgeSent.some((call) => call.path === '/v1/messages') &&
      bridgeBody.enable_thinking === true &&
      bridgeBody.chat_template_kwargs === undefined &&
      bridged.status === 200,
    JSON.stringify({ paths: bridgeSent.map((call) => call.path), status: bridged.status }),
  );

  const azurePreset = await presetPut({
    driver: 'azure-openai',
    baseUrl: `${stub.url}/openai`,
    manifest: undefined,
  });
  check(
    'контур переведён на пресет Azure без своего транспорта',
    azurePreset.status === 200,
    JSON.stringify(azurePreset.body).slice(0, 300),
  );
  const azurePresetBefore = stub.calls.length;
  await api(`/platforms/${encodeURIComponent(CONTOUR)}/check`, { method: 'POST', body: '{}' });
  await gateway(port, '/v1/chat/completions', chat('stub-chat'));
  const azurePresetCalls = stub.calls.slice(azurePresetBefore);
  check(
    'Azure-пресет: и проба, и шлюз отдали ключ в api-key, Authorization не было',
    ['/openai/v1/models', '/openai/v1/chat/completions'].every((path) => {
      const seen = azurePresetCalls.find((call) => call.path === path);
      return seen?.apiKey === KEY && seen.authorization === undefined;
    }),
    JSON.stringify(
      azurePresetCalls.map((call) => ({
        path: call.path,
        apiKey: call.apiKey && '<ключ>',
        authorization: call.authorization && '<есть>',
      })),
    ),
  );

  // ── Транспорт контура (DRV-04/05) ─────────────────────────────────────────
  // Шлюз вида Azure: ключ в `api-key` голым, путь без `/v1`, `api-version` и
  // заголовок арендатора. Проверяется то, что стаб получил из сокета, — и у
  // пробы, и у запроса через шлюз: до этой задачи оба собирали адрес и ключ
  // сами, и починка одного оставляла второй с `Authorization: Bearer`.
  const azure = await api(`/platforms/${encodeURIComponent(CONTOUR)}`, {
    method: 'PUT',
    body: JSON.stringify({
      settings: {
        ...wired.platform,
        driver: 'openai-compat',
        baseUrl: `${stub.url}/openai/deployments/stub`,
        rules: {
          ...wired.platform.rules,
          platform: { ...wired.platform.rules.platform, platformTools: [], toolMode: 'loop' },
        },
        transport: {
          authHeader: 'api-key',
          authScheme: '',
          version: 'as-is',
          query: 'api-version=2024-10-21',
          headers: 'X-Tenant: research',
        },
      },
      token: KEY,
    }),
  });
  check(
    'контур с транспортом Azure сохранён',
    azure.status === 200,
    JSON.stringify(azure.body).slice(0, 300),
  );
  const azureBefore = stub.calls.length;
  await api(`/platforms/${encodeURIComponent(CONTOUR)}/check`, { method: 'POST', body: '{}' });
  const azureChat = await gateway(port, '/v1/chat/completions', {
    model: 'stub-chat',
    stream: true,
    messages: [{ role: 'user', content: 'привет' }],
  });
  const azureCalls = stub.calls.slice(azureBefore);
  for (const [label, suffix] of [
    ['проба', '/models'],
    ['шлюз', '/chat/completions'],
  ]) {
    const seen = azureCalls.find((call) => call.path.endsWith(suffix));
    check(
      `${label}: путь как есть, api-version, ключ в api-key без Authorization, X-Tenant`,
      seen?.path === `/openai/deployments/stub${suffix}` &&
        seen.search === '?api-version=2024-10-21' &&
        seen.apiKey === KEY &&
        seen.authorization === undefined &&
        seen.tenant === 'research',
      JSON.stringify(
        seen
          ? { ...seen, apiKey: seen.apiKey && '<ключ>', body: undefined }
          : azureCalls.map((call) => call.path),
      ),
    );
  }
  check(
    'ответ через транспорт Azure дошёл клиенту',
    azureChat.status === 200,
    `${azureChat.status}: ${azureChat.text.slice(0, 200)}`,
  );

  // ── Каталоги чужой формы и опубликованная цена (DRV-06) ──────────────────
  // Проба идёт кнопкой через маршрут панели, цена — от каталога в хранилище до
  // записи расхода пачкой. До задачи голый массив Together читался как «адрес
  // не API», а цена OpenRouter терялась, и деньги ответа оставались нулём.
  const reshape = (prefix) =>
    api(`/platforms/${encodeURIComponent(CONTOUR)}`, {
      method: 'PUT',
      body: JSON.stringify({
        settings: {
          ...wired.platform,
          driver: 'openai-compat',
          baseUrl: `${stub.url}/${prefix}`,
          rules: {
            ...wired.platform.rules,
            platform: { ...wired.platform.rules.platform, platformTools: [], toolMode: 'loop' },
          },
        },
        token: KEY,
      }),
    });

  await reshape('together');
  const together = await api(`/platforms/${encodeURIComponent(CONTOUR)}/check`, {
    method: 'POST',
    body: '{}',
  });
  const togetherHealth = together.body?.health ?? together.body;
  check(
    'Together: голый массив прочитан как каталог',
    togetherHealth?.outcome === 'ok' &&
      togetherHealth.models?.some((model) => model.id === 'stub-chat' && model.kind === 'chat'),
    JSON.stringify({ outcome: togetherHealth?.outcome, detail: togetherHealth?.detail }),
  );

  await reshape('openrouter');
  const openRouter = await api(`/platforms/${encodeURIComponent(CONTOUR)}/check`, {
    method: 'POST',
    body: '{}',
  });
  const priced = (openRouter.body?.health ?? openRouter.body)?.models?.find(
    (model) => model.id === 'stub-chat',
  );
  check(
    'OpenRouter: зрение, инструменты, потолок провайдера и цена из каталога',
    priced?.vision === true &&
      priced.functionCalling === true &&
      priced.outputLimit === 2048 &&
      priced.price?.input === 1_000_000 &&
      priced.price?.output === 1_000_000,
    JSON.stringify(priced),
  );

  // Расход пишется пачкой раз в SPEND_FLUSH_MS (5 с): ждём сброс хвоста прежних
  // разделов, снимаем счёт, делаем один ответ и ждём его сброс.
  const settle = () => new Promise((resolve) => setTimeout(resolve, 6_000));
  await settle();
  const moneyNow = async () =>
    (await api(`/platforms/${encodeURIComponent(CONTOUR)}/spend`)).body?.total?.money;
  const moneyBefore = await moneyNow();
  const pricedChat = await gateway(port, '/v1/chat/completions', chat('stub-chat'));
  await settle();
  const moneyAfter = await moneyNow();
  // Кадр расхода стаба: 11 входных + 2 выходных токена по доллару за токен.
  check(
    'расход ответа посчитан по цене из каталога шлюза',
    pricedChat.status === 200 &&
      moneyBefore !== undefined &&
      moneyAfter !== undefined &&
      Math.abs(moneyAfter.usd - moneyBefore.usd - 13) < 1e-6 &&
      moneyAfter.unpricedTokens === moneyBefore.unpricedTokens,
    JSON.stringify({ status: pricedChat.status, moneyBefore, moneyAfter }),
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
