/**
 * Картинки чата НА ПРОВОДЕ: весь путь панель → свой шлюз → контур → файл на диске.
 *
 * Чем это отличается от соседей. Модульные тесты `domains/media/*` подставляют
 * транспорт и кормят домен готовыми кадрами; интеграция маршрутов поднимает свою
 * ручку, но не поднимает шлюз. Здесь не подменяется ничего, кроме самой
 * корпоративной платформы: над панелью стоит `stub-platform.mjs` — настоящий
 * HTTP-сервер, отвечающий в форме справочника, — а панель поднимается своя,
 * одноразовая, с каталогом настроек во временной папке. Рабочий стенд человека не
 * трогается, установленный CLI не нужен.
 *
 * Единственное доказательство, которое нельзя подделать разбором ответа, — ФАЙЛ
 * НА ДИСКЕ: байты, дошедшие до каталога данных, сверяются с теми, что отдал стаб.
 *
 * Что прогоняется (каждая строка — обещание панели человеку):
 *   1. план дороги: модель с объявленной генерацией найдена в каталоге ключа,
 *      названы контур, модель и то, что промпт режима уезжает;
 *   2. рисование через СВОЙ шлюз: запрос к контуру ушёл с промптом режима, а
 *      картинка легла файлом — байт в байт с тем, что отдал стаб;
 *   3. след запроса шлюза несёт РАЗМЕР картинки и ни байта её содержимого;
 *   4. настройки панели (`state.json`) не содержат картинки вовсе;
 *   5. отдача файла: тот же адрес, тип из байтов, запрет угадывания, `inline`;
 *   6. чужой идентификатор за каталог данных не выводит;
 *   7. дорога отдельной ручки (профиль эндпоинта) рисует тем же маршрутом;
 *   8. профиль без адреса генерации — запертый режим с НАЗВАННОЙ причиной (В4);
 *   9. нет дороги вовсе — 409 с машинной причиной, и наружу не уходит ничего;
 *  10. Т10, дорога АГЕНТА: без контура и без ключа оба режима доступны, а причина
 *      отсутствия растра названа рядом с рабочей дорогой, а не вместо неё;
 *  11. просьба к агенту собрана сервером из каталога промптов и несёт язык блока;
 *  12. рисунок из блока лёг файлом `.svg`, а скрипт внутри отвергнут с причиной —
 *      и в обоих случаях наружу не ушло ни запроса;
 *  13. колода из блока: файлы на диске, показ с `default-src 'none'`, русское имя
 *      в заголовке скачивания не рушит ответ (оно не лезет в latin1);
 *  14. колода через КОНТУР: запрос ушёл своим шлюзом, ответ разобран блоком.
 *
 * Запуск: `node tools/qa/check-chat-media.mjs`
 * Своего окружения не требует: стаб и панель поднимаются здесь же.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DECK_JSON, startStubPlatform } from './stub-platform.mjs';

const PANEL_PORT = Number(process.env.MEDIA_PANEL_PORT ?? 5195);
const GATEWAY_PORT = Number(process.env.MEDIA_GATEWAY_PORT ?? 5196);
const PANEL = `http://127.0.0.1:${PANEL_PORT}`;
const CONTOUR = 'media-company';

/** Заглушка вместо ключа: собрана из кусков, чтобы в репозитории не лежал секрет. */
const KEY = ['media', 'stub', 'key'].join('-');

/** Байты, которые отдаёт стаб. Ими же проверяется файл на диске. */
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

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
  return { status: res.status, body, headers: res.headers };
}

/** Сырой ответ маршрута файла: заголовки и байты, как их получит браузер. */
async function raw(path) {
  const res = await fetch(`${PANEL}/api${path}`);
  return {
    status: res.status,
    headers: res.headers,
    bytes: Buffer.from(await res.arrayBuffer()),
  };
}

async function main() {
  const stub = await startStubPlatform({ port: 0 });
  const home = mkdtempSync(join(tmpdir(), 'cc-media-wire-'));
  const appData = join(home, 'agentdeck');
  mkdirSync(appData, { recursive: true });
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
    console.log(`Стаб-контур: ${stub.url}\nПанель: ${PANEL}\nКаталог данных: ${appData}\n`);
    await run(stub, appData);
  } finally {
    panel.kill();
    await stub.close();
    rmSync(home, { recursive: true, force: true });
  }

  console.log(failures === 0 ? '\nВсё сходится.' : `\nПровалов: ${failures}`);
  process.exit(failures === 0 ? 0 : 1);
}

async function run(stub, appData) {
  // ── Контур, проба, шлюз ──────────────────────────────────────────────────
  await api(`/platforms/${encodeURIComponent(CONTOUR)}`, {
    method: 'PUT',
    body: JSON.stringify({
      settings: {
        id: CONTOUR,
        title: 'Стаб контура для картинок',
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
  await api(`/platforms/${encodeURIComponent(CONTOUR)}/activate`, { method: 'POST', body: '{}' });
  const probe = await api(`/platforms/${encodeURIComponent(CONTOUR)}/check`, {
    method: 'POST',
    body: '{}',
  });
  const health = probe.body?.health ?? probe.body;
  check(
    'проба прочитала объявленную генерацию картинок из каталога ключа',
    (health?.models ?? []).some((model) => model.id === 'stub-image' && model.imageGeneration),
    JSON.stringify((health?.models ?? []).find((model) => model.id === 'stub-image')),
  );

  await api('/settings', {
    method: 'PATCH',
    body: JSON.stringify({
      platformGateway: { enabled: true, port: GATEWAY_PORT, forceStream: true },
    }),
  });
  const restarted = await api('/platforms/gateway/restart', { method: 'POST', body: '{}' });
  check(
    'шлюз поднят: без него дорога «частью ответа» заперта по своей причине',
    restarted.body?.status?.running === true,
    JSON.stringify(restarted.body?.status).slice(0, 200),
  );

  // ── 1. План дороги ──────────────────────────────────────────────────────
  const plan = await api('/media/images/plan');
  check(
    'план называет контур, модель с флагом и то, что промпт режима уезжает',
    plan.body?.available === true &&
      plan.body?.source === 'contour-chat' &&
      plan.body?.model === 'stub-image' &&
      plan.body?.promptSent === true &&
      plan.body?.compromise === 'media-by-capability',
    JSON.stringify(plan.body),
  );

  // ── 2. Рисование через свой шлюз ────────────────────────────────────────
  const before = stub.calls.length;
  const drawn = await api('/media/images', {
    method: 'POST',
    body: JSON.stringify({ chatId: 'media-chat', prompt: 'кот на подоконнике' }),
  });
  check('картинка нарисована', drawn.status === 200 && drawn.body?.id, JSON.stringify(drawn.body));

  const chatCall = stub.calls.slice(before).find((call) => call.path.endsWith('/chat/completions'));
  const sent = chatCall ? JSON.parse(chatCall.body) : undefined;
  check(
    'запрос ушёл контуру обычным чатом, потоком и с промптом режима системным сообщением',
    sent?.model === 'stub-image' &&
      sent?.stream === true &&
      sent?.messages?.[0]?.role === 'system' &&
      String(sent?.messages?.[0]?.content).includes('рисуешь') &&
      sent?.messages?.[1]?.content === 'кот на подоконнике',
    JSON.stringify(sent).slice(0, 300),
  );
  // Через СВОЙ шлюз, а не напрямую: ключ остался в панели, и заголовок контуру
  // подставила она сама.
  check(
    'ключ контура ушёл заголовком драйвера, а не из запроса панели',
    chatCall?.authorization === `Bearer ${KEY}`,
    JSON.stringify(chatCall?.authorization),
  );

  // Файл на диске — единственное доказательство, которое не подделать разбором.
  const image = drawn.body ?? {};
  const filePath = join(appData, 'media', `${image.id}.png`);
  let onDisk;
  try {
    onDisk = readFileSync(filePath);
  } catch (error) {
    onDisk = undefined;
    bad('байты легли файлом в каталог данных', String(error));
  }
  if (onDisk) {
    check(
      'файл на диске байт в байт совпал с тем, что отдал контур',
      onDisk.equals(PNG_1X1),
      `на диске ${onDisk.length} Б, у стаба ${PNG_1X1.length} Б`,
    );
  }
  check(
    'запись описывает картинку: тип из байтов, размер, дорога и модель',
    image.mime === 'image/png' &&
      image.sizeBytes === PNG_1X1.length &&
      image.source === 'contour-chat' &&
      image.model === 'stub-image' &&
      image.width === 1 &&
      image.height === 1,
    JSON.stringify(image),
  );
  check(
    'байтов картинки в ответе маршрута нет: карточка берёт их файлом',
    !JSON.stringify(image).includes(PNG_1X1.toString('base64').slice(0, 16)),
    JSON.stringify(image).slice(0, 200),
  );

  // ── 3. След запроса ─────────────────────────────────────────────────────
  const status = await api('/platforms/gateway');
  // След — новые первыми. С тех пор как активация сама поднимает шлюз, её
  // пробный запрос тоже ложится в след (`/v1/messages`), и «последний в списке»
  // читал его, а не рисование. Рисование — самый свежий обычный чат контура.
  const event = (status.body?.status?.events ?? []).find(
    (item) => item.platformId === CONTOUR && item.path.endsWith('/chat/completions'),
  );
  check(
    'рисование прошло через свой шлюз и попало в след запроса',
    Boolean(event) && event.status === 200,
    JSON.stringify(event).slice(0, 200),
  );
  check(
    'след несёт РАЗМЕР картинки и ни байта её содержимого',
    (event?.imageBytes ?? 0) > 0 && !JSON.stringify(event).includes('iVBORw0KGgo'),
    JSON.stringify(event).slice(0, 300),
  );
  // Контур не прислал счёта за картинку (как платформа компании): след говорит это, а не
  // молчаливый ноль, который читался бы «бесплатно» (аудит MD-09).
  check(
    'расход не сообщён — след называет это, а не пишет ноль',
    event?.usageUnreported === true && event?.totalTokens === 0,
    JSON.stringify({ usageUnreported: event?.usageUnreported, totalTokens: event?.totalTokens }),
  );

  // ── 4. Настройки панели ─────────────────────────────────────────────────
  const state = readFileSync(join(appData, 'state.json'), 'utf8');
  check(
    'в state.json нет ни байта картинки: настройки человек читает и переносит архивом',
    !state.includes('data:image/png') && !state.includes(PNG_1X1.toString('base64').slice(0, 16)),
    `длина state.json ${state.length}`,
  );

  // ── 5. Отдача файла ─────────────────────────────────────────────────────
  const file = await raw(`/media/images/${image.id}`);
  check(
    'файл отдан тем же адресом: тип из байтов, без угадывания, inline с именем',
    file.status === 200 &&
      file.headers.get('content-type') === 'image/png' &&
      file.headers.get('x-content-type-options') === 'nosniff' &&
      file.headers.get('cache-control') === 'no-store' &&
      file.headers.get('content-disposition') === `inline; filename="${image.name}"` &&
      file.bytes.equals(PNG_1X1),
    `${file.status} ${file.headers.get('content-type')} ${file.headers.get('content-disposition')}`,
  );

  // ── 6. Чужой идентификатор ──────────────────────────────────────────────
  const traversal = await raw('/media/images/..%2F..%2Fstate');
  const missing = await raw('/media/images/0123456789abcdef');
  check(
    'чужой идентификатор не выводит чтение за каталог данных',
    traversal.status === 400 && missing.status === 404,
    `${traversal.status} / ${missing.status}`,
  );

  await contourImagesViaGateway(stub, appData);

  // ── 7–8. Дорога отдельной ручки ─────────────────────────────────────────
  // Контур выключаем: дальше проверяется профиль человека, а рисующий контур
  // выбрал бы дорогу за него. Своим маршрутом, а не полем настроек: активность
  // переключается только им (инвариант 1), и патч настроек её не тронет.
  const off = await api(`/platforms/${encodeURIComponent(CONTOUR)}/deactivate`, {
    method: 'POST',
    body: '{}',
  });
  check(
    'контур выключен своим маршрутом',
    off.status === 200 && !off.body?.activePlatformId,
    JSON.stringify(off.body).slice(0, 200),
  );
  await api('/settings', {
    method: 'PATCH',
    body: JSON.stringify({
      endpointProfiles: [
        {
          id: 'own',
          name: 'Своя модель',
          baseUrl: `${stub.url}/v1`,
          apiKind: 'openai-compat',
          model: 'stub-image',
          writeToken: false,
          imagesUrl: '',
          ownerPlatformId: '',
        },
      ],
    }),
  });
  const noUrl = await api('/media/images/plan');
  check(
    'профиль без адреса генерации: растровая причина названа (В4), а запирает режим только отсутствие разговора (Т10)',
    noUrl.body?.available === false &&
      noUrl.body?.reason === 'no-agent' &&
      noUrl.body?.rasterReason === 'endpoint-no-url',
    JSON.stringify(noUrl.body),
  );
  const noUrlWithAgent = await api('/media/images/plan?agent=1');
  check(
    'тот же профиль с разговором рядом: режим РАБОТАЕТ вектором, причина отсутствия растра — рядом с ним',
    noUrlWithAgent.body?.available === true &&
      noUrlWithAgent.body?.source === 'agent' &&
      noUrlWithAgent.body?.rasterReason === 'endpoint-no-url',
    JSON.stringify(noUrlWithAgent.body),
  );

  await api('/settings', {
    method: 'PATCH',
    body: JSON.stringify({
      endpointProfiles: [
        {
          id: 'own',
          name: 'Своя модель',
          baseUrl: `${stub.url}/v1`,
          apiKind: 'openai-compat',
          model: 'stub-image',
          writeToken: false,
          imagesUrl: `${stub.url}/images/generations`,
          ownerPlatformId: '',
        },
      ],
    }),
  });
  const viaEndpoint = await api('/media/images', {
    method: 'POST',
    body: JSON.stringify({ chatId: '', prompt: 'логотип' }),
  });
  const endpointCall = stub.calls
    .filter((call) => call.path.endsWith('/images/generations'))
    .at(-1);
  const endpointBody = endpointCall ? JSON.parse(endpointCall.body) : undefined;
  check(
    'дорога ручки картинок: адрес из профиля, просьба о самих байтах, файл на диске',
    viaEndpoint.status === 200 &&
      viaEndpoint.body?.source === 'endpoint' &&
      endpointBody?.response_format === 'b64_json' &&
      endpointBody?.prompt === 'логотип' &&
      readFileSync(join(appData, 'media', `${viaEndpoint.body?.id}.png`)).equals(PNG_1X1),
    `${viaEndpoint.status} ${String(JSON.stringify(endpointBody)).slice(0, 160)}`,
  );

  // ── 9. Нет дороги вовсе ─────────────────────────────────────────────────
  await api('/settings', { method: 'PATCH', body: JSON.stringify({ endpointProfiles: [] }) });
  const wall = stub.calls.length;
  const refused = await api('/media/images', {
    method: 'POST',
    body: JSON.stringify({ chatId: '', prompt: 'кот' }),
  });
  check(
    'нет дороги — 409 с машинной причиной, и наружу не ушло ни запроса',
    refused.status === 409 && refused.body?.reason === 'no-route' && stub.calls.length === wall,
    `${refused.status} ${JSON.stringify(refused.body)}`,
  );

  await mediaEverywhere(stub, appData);
}

/**
 * 6б. Ручка картинок КОНТУРА (`images: { api }`) — тоже через свой шлюз.
 *
 * До 17.09.2026 эта дорога шла напрямую ключом контура: ни следа, ни расхода, ни
 * перевода отказов, ни защиты данных. Доказательство здесь — строка в следе
 * шлюза с путём ручки картинок: мимо шлюза её не записал бы никто. Отказ 451
 * обязан прийти переведённым и помеченным как отказ проверок, а 503 — ровно ОДНИМ
 * запросом наверх: платная картинка повтором рисуется и списывается дважды.
 */
async function contourImagesViaGateway(stub, appData) {
  const put = await api(`/platforms/${encodeURIComponent(CONTOUR)}`, {
    method: 'PUT',
    body: JSON.stringify({
      settings: {
        id: CONTOUR,
        title: 'Стаб контура для картинок',
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
        manifest: { imagesApi: 'images/generations' },
      },
    }),
  });
  const plan = await api('/media/images/plan');
  check(
    'контур с ручкой картинок в манифесте: дорога «ручка контура» и модель с флагом',
    put.status === 200 &&
      plan.body?.available === true &&
      plan.body?.source === 'contour-images' &&
      plan.body?.model === 'stub-image',
    `${put.status} ${JSON.stringify(plan.body)}`,
  );

  const before = stub.calls.length;
  const drawn = await api('/media/images', {
    method: 'POST',
    body: JSON.stringify({ chatId: 'media-chat', prompt: 'маяк на скале' }),
  });
  const calls = stub.calls.slice(before);
  const imageCall = calls.find((call) => call.path.endsWith('/images/generations'));
  const sent = imageCall ? JSON.parse(imageCall.body) : undefined;
  const onDisk = drawn.body?.id
    ? readFileSync(join(appData, 'media', `${drawn.body.id}.png`))
    : undefined;
  check(
    'ручка контура: запрос с просьбой о байтах, ключ подставлен шлюзом, файл байт в байт',
    drawn.status === 200 &&
      drawn.body?.source === 'contour-images' &&
      sent?.prompt === 'маяк на скале' &&
      sent?.response_format === 'b64_json' &&
      imageCall?.authorization === `Bearer ${KEY}` &&
      calls.length === 1 &&
      Boolean(onDisk?.equals(PNG_1X1)),
    `${drawn.status} ${JSON.stringify(drawn.body).slice(0, 200)} вызовов=${calls.length}`,
  );

  const gateway = await api('/platforms/gateway');
  const imageEvents = (gateway.body?.status?.events ?? []).filter(
    (item) => item.platformId === CONTOUR && item.path.endsWith('/v1/images/generations'),
  );
  const event = imageEvents[0];
  check(
    'рисование ручкой контура прошло через СВОЙ шлюз: в следе путь ручки, размер и «расход не сообщён»',
    event?.status === 200 &&
      (event?.imageBytes ?? 0) > 0 &&
      event?.usageUnreported === true &&
      !JSON.stringify(event).includes('iVBORw0KGgo'),
    String(JSON.stringify(event)).slice(0, 300),
  );

  const beforeRefusal = stub.calls.length;
  const refused = await api('/media/images', {
    method: 'POST',
    body: JSON.stringify({ chatId: '', prompt: 'stub-451 паспорт' }),
  });
  const afterRefusal = await api('/platforms/gateway');
  const refusalEvent = (afterRefusal.body?.status?.events ?? []).find(
    (item) => item.platformId === CONTOUR && item.path.endsWith('/v1/images/generations'),
  );
  check(
    'отказ проверок ручки картинок переведён шлюзом: причина словами, в следе «заблокировано» и имена правил',
    refused.status === 502 &&
      String(refused.body?.message ?? '').includes('AgentDeck') &&
      !String(refused.body?.message ?? '').includes('Иванов') &&
      refusalEvent?.blocked === true &&
      (refusalEvent?.violations ?? []).length > 0 &&
      stub.calls.length - beforeRefusal === 1,
    `${refused.status} ${JSON.stringify(refused.body)} ${String(JSON.stringify(refusalEvent)).slice(0, 240)}`,
  );

  const beforeDown = stub.calls.length;
  const down = await api('/media/images', {
    method: 'POST',
    body: JSON.stringify({ chatId: '', prompt: 'stub-503 закат' }),
  });
  check(
    'временный отказ ручки картинок НЕ повторяется: платная картинка — один запрос наверх',
    down.status === 502 && stub.calls.length - beforeDown === 1,
    `${down.status} вызовов=${stub.calls.length - beforeDown} ${JSON.stringify(down.body)}`,
  );
}

/**
 * Т10: оба режима без контура и без ключа.
 *
 * Здесь уже нет ни активного контура, ни профиля эндпоинта — то есть ровно то
 * положение, в котором Т9 запирала режим словами «рисовать некому». Проверяется,
 * что дорога агента работает именно в нём, и что панель НИЧЕГО не отправляет
 * наружу: колоду и рисунок она собирает из блока, который агент уже сказал.
 */
async function mediaEverywhere(stub, appData) {
  // ── 10. Дорога агента без контура вовсе ─────────────────────────────────
  const bare = await api('/media/images/plan?agent=1');
  check(
    'без контура и без ключа «Картинка» доступна вектором, причина отсутствия растра названа',
    bare.body?.available === true &&
      bare.body?.source === 'agent' &&
      bare.body?.rasterReason === 'no-route' &&
      bare.body?.promptSent === true,
    JSON.stringify(bare.body),
  );
  const bareDeck = await api('/media/decks/plan?agent=1');
  check(
    'и «Презентация» — тоже, с честным ответом про PDF на этой машине',
    bareDeck.body?.available === true &&
      bareDeck.body?.source === 'agent' &&
      typeof bareDeck.body?.pdf?.available === 'boolean' &&
      (bareDeck.body.pdf.available || bareDeck.body.pdf.reason === 'no-browser'),
    JSON.stringify(bareDeck.body),
  );
  const lockedDeck = await api('/media/decks/plan');
  check(
    'без разговора и без дорог презентация заперта с машинной причиной',
    lockedDeck.body?.available === false && lockedDeck.body?.reason === 'no-route',
    JSON.stringify(lockedDeck.body),
  );

  // ── 11. Просьба к агенту ────────────────────────────────────────────────
  const deckAsk = await api('/media/prompt', {
    method: 'POST',
    body: JSON.stringify({ kind: 'deck', topic: 'итоги партии' }),
  });
  const pictureAsk = await api('/media/prompt', {
    method: 'POST',
    body: JSON.stringify({ kind: 'picture', topic: 'схема шлюза' }),
  });
  check(
    'просьбу собирает сервер: в ней язык блока, правила каталога и тема человека',
    String(deckAsk.body?.prompt).includes('agentdeck:deck') &&
      String(deckAsk.body?.prompt).includes('итоги партии') &&
      String(pictureAsk.body?.prompt).includes('agentdeck:svg') &&
      String(pictureAsk.body?.prompt).includes('схема шлюза'),
    `${String(deckAsk.body?.prompt).slice(0, 80)} | ${String(pictureAsk.body?.prompt).slice(0, 80)}`,
  );

  // ── 12. Рисунок из блока ────────────────────────────────────────────────
  const quiet = stub.calls.length;
  const svg =
    '<svg viewBox="0 0 10 10" xmlns="http://www.w3.org/2000/svg"><rect width="10" height="10"/></svg>';
  const saved = await api('/media/images/block', {
    method: 'POST',
    body: JSON.stringify({ chatId: 'agent-chat', prompt: 'квадрат', block: svg, model: 'opus' }),
  });
  let svgOnDisk;
  try {
    svgOnDisk = readFileSync(join(appData, 'media', `${saved.body?.id}.svg`), 'utf8');
  } catch (error) {
    svgOnDisk = String(error);
  }
  check(
    'рисунок агента лёг файлом .svg своим типом, с моделью разговора в записи',
    saved.status === 200 &&
      saved.body?.mime === 'image/svg+xml' &&
      saved.body?.source === 'agent' &&
      saved.body?.model === 'opus' &&
      svgOnDisk.includes('<rect'),
    `${saved.status} ${JSON.stringify(saved.body)} ${svgOnDisk.slice(0, 60)}`,
  );
  const armed = await api('/media/images/block', {
    method: 'POST',
    body: JSON.stringify({
      chatId: '',
      prompt: '',
      block: '<svg xmlns="http://www.w3.org/2000/svg"><script>fetch("http://x")</script></svg>',
      model: '',
    }),
  });
  check(
    'рисунок со скриптом отвергнут с НАЗВАННОЙ причиной, а не молча',
    armed.status === 400 && String(armed.body?.message ?? '').includes('скрипт'),
    `${armed.status} ${JSON.stringify(armed.body)}`,
  );
  check(
    'приём блока не шлёт наружу ни одного запроса: панель собирает из уже сказанного',
    stub.calls.length === quiet,
    `${stub.calls.length - quiet} лишних запросов`,
  );

  // ── 13. Колода из блока ─────────────────────────────────────────────────
  const dictated = await api('/media/decks/block', {
    method: 'POST',
    body: JSON.stringify({
      chatId: 'agent-chat',
      prompt: 'итоги партии',
      block: JSON.stringify(DECK_JSON),
      model: 'opus',
    }),
  });
  const deck = dictated.body ?? {};
  let deckOnDisk;
  try {
    // Колоды лежат своей папкой: на один идентификатор у них несколько файлов.
    deckOnDisk = readFileSync(join(appData, 'media', 'decks', `${deck.id}.html`), 'utf8');
  } catch (error) {
    deckOnDisk = String(error);
  }
  check(
    'колода собрана панелью: слайды сосчитаны, дорога и модель названы, HTML на диске',
    dictated.status === 200 &&
      // Титульный слайд панель делает сама: считается и он.
      deck.slideCount === DECK_JSON.slides.length + 1 &&
      deck.source === 'agent' &&
      deck.model === 'opus' &&
      deck.title === DECK_JSON.title &&
      (deck.formats ?? []).includes('html') &&
      (deck.formats ?? []).includes('pptx') &&
      deckOnDisk.includes(DECK_JSON.title),
    `${dictated.status} ${JSON.stringify(deck)} ${deckOnDisk.slice(0, 120)}`,
  );
  check(
    'приём колоды тоже обошёлся без сети',
    stub.calls.length === quiet,
    `${stub.calls.length - quiet} лишних запросов`,
  );

  const html = await raw(`/media/decks/${deck.id}/html`);
  check(
    'показ колоды запрещает сеть заголовком, а не обещанием',
    html.status === 200 &&
      String(html.headers.get('content-security-policy')).includes("default-src 'none'") &&
      html.headers.get('x-content-type-options') === 'nosniff' &&
      html.bytes.toString('utf8').includes('Что сделано'),
    `${html.status} ${html.headers.get('content-security-policy')}`,
  );
  const pptx = await raw(`/media/decks/${deck.id}/pptx`);
  const shown = String(pptx.headers.get('content-disposition') ?? '');
  check(
    'PPTX приходит вложением, а РУССКОЕ имя не рушит заголовок: latin1-опора плюс RFC 5987',
    pptx.status === 200 &&
      pptx.headers.get('content-type') ===
        'application/vnd.openxmlformats-officedocument.presentationml.presentation' &&
      shown.startsWith('attachment;') &&
      shown.includes("filename*=UTF-8''") &&
      /filename="[\x20-\x7e]+"/.test(shown) &&
      pptx.bytes.subarray(0, 2).toString('utf8') === 'PK',
    `${pptx.status} ${shown}`,
  );
  const pdf = await raw(`/media/decks/${deck.id}/pdf`);
  const promisedPdf = (deck.formats ?? []).includes('pdf');
  check(
    promisedPdf
      ? 'PDF напечатан системным браузером — ровно то, что обещал список видов'
      : 'PDF не обещан, и отказ называет причину: печатать нечем',
    promisedPdf
      ? pdf.status === 200 && pdf.bytes.subarray(0, 5).toString('utf8') === '%PDF-'
      : pdf.status === 409,
    `обещан=${promisedPdf} ${pdf.status} ${pdf.bytes.subarray(0, 8).toString('utf8')}`,
  );

  // ── 14. Колода через контур ──────────────────────────────────────────────
  await api(`/platforms/${encodeURIComponent(CONTOUR)}`, {
    method: 'PUT',
    body: JSON.stringify({
      settings: {
        id: CONTOUR,
        title: 'Стаб контура для картинок',
        driver: 'enterprise-platform',
        baseUrl: stub.url,
        enabled: true,
        mode: 'best-effort',
        defaultModel: 'stub-deck',
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
  await api(`/platforms/${encodeURIComponent(CONTOUR)}/activate`, { method: 'POST', body: '{}' });
  const viaPlan = await api('/media/decks/plan');
  check(
    'без разговора колоду диктует контур: названы он сам и модель запроса',
    viaPlan.body?.available === true &&
      viaPlan.body?.source === 'contour' &&
      viaPlan.body?.model === 'stub-deck',
    JSON.stringify(viaPlan.body),
  );

  const mark = stub.calls.length;
  const viaContour = await api('/media/decks', {
    method: 'POST',
    body: JSON.stringify({ chatId: '', prompt: 'итоги партии' }),
  });
  const deckCall = stub.calls.slice(mark).find((call) => call.path.endsWith('/chat/completions'));
  const sentDeck = deckCall ? JSON.parse(deckCall.body) : undefined;
  check(
    'запрос ушёл контуру своим шлюзом: правила каталога системным сообщением, тема человека, ключ от драйвера',
    sentDeck?.model === 'stub-deck' &&
      sentDeck?.messages?.[0]?.role === 'system' &&
      String(sentDeck?.messages?.at(-1)?.content).includes('итоги партии') &&
      deckCall?.authorization === `Bearer ${KEY}`,
    JSON.stringify(sentDeck).slice(0, 240),
  );
  let contourOnDisk;
  try {
    contourOnDisk = readFileSync(
      join(appData, 'media', 'decks', `${viaContour.body?.id}.html`),
      'utf8',
    );
  } catch (error) {
    contourOnDisk = String(error);
  }
  check(
    'ответ контура разобран блоком: слайды те самые, файл на диске',
    viaContour.status === 200 &&
      viaContour.body?.source === 'contour' &&
      viaContour.body?.slideCount === DECK_JSON.slides.length + 1 &&
      contourOnDisk.includes('Что дальше'),
    `${viaContour.status} ${JSON.stringify(viaContour.body)} ${contourOnDisk.slice(0, 120)}`,
  );

  // ── 15. Картинки слайдам: панель дорисовывает СВОЕЙ дорогой ──────────────
  // Проверяется то, что нельзя подделать разбором: байты картинки внутри HTML
  // колоды. Ссылка наружу была бы пустым местом на показе без сети.
  const illustrated = await api('/media/decks/block', {
    method: 'POST',
    body: JSON.stringify({
      chatId: 'agent-chat',
      prompt: 'итоги партии с картинками',
      block: JSON.stringify({
        ...DECK_JSON,
        slides: DECK_JSON.slides.map((slide, index) =>
          index === 0 ? { ...slide, illustration: 'рассвет над городом' } : slide,
        ),
      }),
      model: 'opus',
    }),
  });
  const withPicture = await raw(`/media/decks/${illustrated.body?.id}/html`);
  check(
    'панель дорисовала картинку слайду и вшила её БАЙТАМИ: ни одной ссылки в сеть',
    illustrated.status === 200 &&
      illustrated.body?.drawnPictures === 1 &&
      illustrated.body?.pictureReason === undefined &&
      withPicture.status === 200 &&
      withPicture.bytes.toString('utf8').includes('data:image/png;base64,'),
    `${illustrated.status} ${JSON.stringify(illustrated.body)}`,
  );

  // ── 16. Правка колоды: помнит панель, а не агент ─────────────────────────
  const revisePrompt = await api('/media/prompt', {
    method: 'POST',
    body: JSON.stringify({
      kind: 'deck-revise',
      topic: 'третий слайд короче',
      reviseOf: illustrated.body?.id,
    }),
  });
  const askedRevise = String(revisePrompt.body?.prompt ?? '');
  check(
    'просьба поправить несёт прежнюю колоду целиком, её картинку и запрет отвечать разницей',
    revisePrompt.status === 200 &&
      askedRevise.includes(DECK_JSON.title) &&
      askedRevise.includes('третий слайд короче') &&
      askedRevise.includes('ВСЯ колода после правки') &&
      askedRevise.includes('pictureId'),
    `${revisePrompt.status} ${askedRevise.slice(0, 200)}`,
  );
  const goneRevise = await api('/media/prompt', {
    method: 'POST',
    body: JSON.stringify({ kind: 'deck-revise', topic: 'поправь', reviseOf: 'f'.repeat(20) }),
  });
  check(
    'правка колоды, которой уже нет, — 404 словами, а не молчаливая новая колода',
    goneRevise.status === 404 && String(goneRevise.body?.message ?? '').includes('уже нет'),
    `${goneRevise.status} ${JSON.stringify(goneRevise.body)}`,
  );

  const previousPicture =
    JSON.parse(
      readFileSync(join(appData, 'media', 'decks', `${illustrated.body?.id}.json`), 'utf8'),
    )?.deck?.slides?.[0]?.pictureId ?? '';
  const revised = await api('/media/decks/block', {
    method: 'POST',
    body: JSON.stringify({
      chatId: 'agent-chat',
      prompt: 'итоги партии с картинками',
      block: JSON.stringify({
        ...DECK_JSON,
        title: `${DECK_JSON.title} — коротко`,
        slides: DECK_JSON.slides.map((slide, index) => {
          // Первому слайду модель вернула СВОЮ картинку, второму — чужое имя:
          // так в колоду вписали бы любой файл хранилища, и он уехал бы в PPTX.
          if (index === 0) return { ...slide, pictureId: previousPicture };
          if (index === 1) return { ...slide, pictureId: 'ab'.repeat(8) };
          return slide;
        }),
      }),
      model: 'opus',
      reviseOf: illustrated.body?.id,
    }),
  });
  const revisedDeck = revised.body?.id
    ? JSON.parse(readFileSync(join(appData, 'media', 'decks', `${revised.body.id}.json`), 'utf8'))
    : {};
  check(
    'правка помнит, что она правка: своя картинка перешла без нового запроса, чужое имя выброшено',
    revised.status === 200 &&
      previousPicture !== '' &&
      revised.body?.revisionOf === illustrated.body?.id &&
      revised.body?.drawnPictures === undefined &&
      revisedDeck?.deck?.slides?.[0]?.pictureId === previousPicture &&
      revisedDeck?.deck?.slides?.[1]?.pictureId === undefined,
    `${revised.status} ${JSON.stringify(revised.body)}`,
  );
  check(
    'прежняя колода на диске осталась: неудачная правка не забирает показанное',
    existsSync(join(appData, 'media', 'decks', `${illustrated.body?.id}.html`)),
    `нет файла ${illustrated.body?.id}.html`,
  );
}

main().catch((error) => {
  if (error instanceof NotChecked) {
    console.error(`\nНЕ ПРОВЕРЕНО: ${error.message}`);
    process.exit(2);
  }
  console.error(error);
  process.exit(1);
});
