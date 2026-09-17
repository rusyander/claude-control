/**
 * Прослойка инструментов НА ПРОВОДЕ: настоящий `claude` через настоящий шлюз
 * создаёт файл, хотя контур не принимает `tools` вовсе (Т5.2).
 *
 * Чем это отличается от соседей. Модульные тесты прослойки кормят разборщик
 * строкой, а интеграционные — кадрами, собранными тут же в тесте: зелёные и
 * тогда, когда ни один настоящий CLI синтезированный вызов не принял бы.
 * `check-platform-wire.mjs` ходит по проводу, но клиентом там `fetch` — то есть
 * проверка сама играет роль агента. Здесь клиент НАСТОЯЩИЙ: `claude.exe` со
 * своим системным промптом, своим набором инструментов и своими правами на
 * запись. Подменена одна вещь — модель: она скриптована (`stub-tool-shim`),
 * поэтому прогон детерминирован, не ходит в сеть и ничего не стоит.
 *
 * Так воспроизводится сценарий H1 (§2.3 партии): модель отвечает ТЕКСТОМ по
 * протоколу, шлюз собирает из него настоящий `tool_use`, CLI исполняет его и
 * пишет файл на диск. Файл на диске — единственное доказательство, которое
 * нельзя подделать разбором.
 *
 * Что прогоняется:
 *   1. файл создан настоящим CLI через синтезированный вызов;
 *   2. наверх НЕ ушло поле `tools`, а ушёл `tool_choice: "none"` (Т5.4);
 *   3. инструменты клиента доехали до модели ТЕКСТОМ, поимённо;
 *   4. результат вызова вернулся наверх текстом протокола — история цела, и это
 *      именно результат, а не пример результата из самого промпта;
 *   5. след запроса в панели называет `tools: shimmed` и считает вызовы;
 *   6. карточка «Инструменты через контур» видит ход с вызовом;
 *   7. две другие живые формы ответа — ответ, который ЦЕЛИКОМ забор без метки,
 *      доводит вызов до файла, а пример протокола в заборе посреди ответа не
 *      трогает файл ничем и назван человеку причиной;
 *   8. с ВЫКЛЮЧЕННОЙ прослойкой тот же прогон файла не создаёт — проверка
 *      умеет краснеть, и краснеет именно от прослойки;
 *   9. совместимый шлюз (`clientTools: 'native'`) без прослойки доводит вызов
 *      до файла ПОЛЕМ: схемы уходят `tools`, результат — ролью `tool`.
 *
 * Запуск: `node tools/qa/check-tool-shim.mjs`
 * Нужен установленный `claude` (путь можно задать `CLAUDE_CLI`); стенд человека
 * не трогается — панель поднимается своя, одноразовая.
 */
import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { startStubPlatform } from './stub-platform.mjs';

const PANEL_PORT = Number(process.env.SHIM_PANEL_PORT ?? 5193);
const GATEWAY_PORT = Number(process.env.SHIM_GATEWAY_PORT ?? 5194);
const PANEL = `http://127.0.0.1:${PANEL_PORT}`;
const CONTOUR = 'shim-company';
const MODEL = 'stub-tool-shim';

/** Заглушки вместо ключей: собраны из кусков, чтобы в репозитории не лежало присваивание, похожее на секрет. */
const KEY = ['shim', 'stub', 'key'].join('-');
/** Та же строка-заглушка, которой панель разворачивает прогон на контур: ключ там не нужен. */
const ROUTE_TOKEN = ['panel', 'contour', 'no', 'key', 'needed'].join('-');

/** Текст, который скриптованная модель просит записать. */
const EXPECTED = 'прослойка довела вызов';
/** Имя создаваемого файла: по нему настоящий результат вызова отличается от примера в промпте. */
const FILE_NAME = 'shim-proof.txt';

let failures = 0;
const ok = (name) => console.log(`  ✓ ${name}`);
const bad = (name, detail) => {
  failures += 1;
  console.log(`  ✗ ${name}\n    ${detail}`);
};
const check = (name, condition, detail) => (condition ? ok(name) : bad(name, detail));

class NotChecked extends Error {}

/**
 * Путь до настоящего CLI.
 *
 * На Windows берётся `claude.exe` пакета, а не `claude.cmd` из PATH: `.cmd`
 * нельзя запустить без оболочки (Node отвечает EINVAL), а с оболочкой кавычки
 * задания разбирает `cmd.exe` — тот самый разбор, из-за которого промпт уже
 * однажды подменялся обломком.
 */
function resolveClaude() {
  if (process.env.CLAUDE_CLI) return process.env.CLAUDE_CLI;
  if (process.platform !== 'win32') return 'claude';
  const tail = join('node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
  const roots = [dirname(process.execPath), join(process.env.APPDATA ?? '', 'npm')];
  for (const root of roots) {
    const exe = join(root, tail);
    if (existsSync(exe)) return exe;
  }
  return '';
}

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

/** Состояние шлюза: по нему человек и читает, что было с запросом. */
async function gatewayStatus() {
  const status = await api('/platforms/gateway');
  return status.body?.status ?? {};
}

/**
 * Один прогон настоящего CLI через шлюз. Возвращает, создался ли файл, его
 * содержимое, вывод и код выхода.
 */
async function runClaude(exe, port, label, model = MODEL, contour = CONTOUR) {
  // Короткое имя 8.3 (`RUSYAN~1` в пути TEMP) CLI считает подозрительным путём
  // и требует ручного подтверждения даже в `acceptEdits` — разворачиваем путь в
  // настоящий, иначе запись не состоится по причине, к прослойке не
  // относящейся вовсе.
  const work = realpathSync.native(mkdtempSync(join(tmpdir(), `cc-shim-${label}-`)));
  const home = realpathSync.native(mkdtempSync(join(tmpdir(), `cc-shim-home-${label}-`)));
  const target = join(work, FILE_NAME).replace(/\\/g, '/');

  // Свой дом CLI: настоящий `~/.claude` человека не читается и не правится.
  writeFileSync(
    join(home, '.claude.json'),
    JSON.stringify({
      hasCompletedOnboarding: true,
      projects: { [work]: { hasTrustDialogAccepted: true, allowedTools: [] } },
    }),
    'utf8',
  );

  const cli = spawn(
    exe,
    [
      '-p',
      `Запиши текст «${EXPECTED}». ФАЙЛ: ${target}`,
      '--permission-mode',
      'acceptEdits',
      '--max-turns',
      '4',
    ],
    {
      cwd: work,
      env: {
        ...process.env,
        CLAUDE_CONFIG_DIR: home,
        // Ровно те переменные, которыми панель разворачивает прогон на контур
        // (Т3): адрес шлюза с контуром в пути и токен-заглушка.
        ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}/${contour}`,
        ANTHROPIC_AUTH_TOKEN: ROUTE_TOKEN,
        ANTHROPIC_MODEL: model,
        DISABLE_TELEMETRY: '1',
        DISABLE_AUTOUPDATER: '1',
        DISABLE_ERROR_REPORTING: '1',
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
    },
  );

  let out = '';
  cli.stdout.on('data', (chunk) => (out += chunk));
  cli.stderr.on('data', (chunk) => (out += chunk));
  const code = await new Promise((done) => {
    const timer = setTimeout(() => {
      cli.kill();
      done('таймаут');
    }, 120_000);
    cli.on('close', (value) => {
      clearTimeout(timer);
      done(value);
    });
  });

  const created = existsSync(target);
  const content = created ? readFileSync(target, 'utf8') : '';
  rmSync(work, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
  return { code, out, created, content, target };
}

async function main() {
  const exe = resolveClaude();
  if (!exe) {
    throw new NotChecked('не нашёлся настоящий `claude` — задайте путь через CLAUDE_CLI.');
  }

  const stub = await startStubPlatform({ port: 0 });
  const home = mkdtempSync(join(tmpdir(), 'cc-shim-panel-'));
  writeFileSync(join(home, 'settings.json'), '{}\n', 'utf8');

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
    console.log(`CLI: ${exe}\nСтаб-контур: ${stub.url}\nПанель: ${PANEL}\n`);
    await run(stub, exe);
  } finally {
    panel.kill();
    await stub.close();
    rmSync(home, { recursive: true, force: true });
  }

  console.log(failures === 0 ? '\nВсё сходится.' : `\nПровалов: ${failures}`);
  process.exit(failures === 0 ? 0 : 1);
}

/** Контур с нужным состоянием прослойки + поднятый на него шлюз. */
async function openGateway(stub, toolShim, contour = CONTOUR, driver = 'enterprise-platform') {
  await api(`/platforms/${encodeURIComponent(contour)}`, {
    method: 'PUT',
    body: JSON.stringify({
      settings: {
        id: contour,
        title: 'Стаб контура для прослойки',
        driver,
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
        toolShim,
      },
      token: KEY,
    }),
  });
  // Сохранение контур не включает (Т2, инвариант 1): активность переключается
  // своим маршрутом, иначе шлюз отвечал бы «контур выключен в панели».
  await api(`/platforms/${encodeURIComponent(contour)}/activate`, { method: 'POST', body: '{}' });
  await api('/settings', {
    method: 'PATCH',
    body: JSON.stringify({
      platformGateway: { enabled: true, port: GATEWAY_PORT, forceStream: true },
    }),
  });
  const restarted = await api('/platforms/gateway/restart', { method: 'POST', body: '{}' });
  return restarted.body?.status?.port ?? GATEWAY_PORT;
}

async function run(stub, exe) {
  const port = await openGateway(stub, true);
  const before = stub.calls.length;

  console.log('Прогон 1: прослойка включена (может занять до минуты)…');
  const first = await runClaude(exe, port, 'on');

  // ── 1. Файл на диске ─────────────────────────────────────────────────────
  check(
    'настоящий CLI создал файл по синтезированному вызову',
    first.created && first.content.includes(EXPECTED),
    `код ${first.code}, файл ${first.created ? 'есть' : 'НЕ создан'}: ${first.out.slice(-400)}`,
  );

  const upstream = stub.calls
    .slice(before)
    .filter((call) => call.path.endsWith('/chat/completions'))
    .map((call) => ({ raw: call.body, json: JSON.parse(call.body || '{}') }))
    .filter((call) => call.json.model === MODEL);

  if (upstream.length === 0) {
    bad('запросы прослойки дошли до контура', 'ни одного запроса с моделью прослойки');
    return;
  }

  // ── 2. Чего наверх не ушло ───────────────────────────────────────────────
  // Платформа не принимает `tools` вовсе (`no-client-tools`), а свой набор
  // подбирает сама — включённым он перебивал бы протокол, которому мы только
  // что научили модель.
  check(
    'поле `tools` наверх не ушло ни разу',
    upstream.every((call) => call.json.tools === undefined),
    JSON.stringify(Object.keys(upstream[0].json)),
  );
  check(
    'наверх ушёл `tool_choice: "none"`',
    upstream.every((call) => call.json.tool_choice === 'none'),
    JSON.stringify(upstream.map((call) => call.json.tool_choice)),
  );

  // ── 3. Инструменты текстом ───────────────────────────────────────────────
  const systemText = (upstream[0].json.messages ?? [])
    .filter((message) => message.role === 'system')
    .map((message) =>
      typeof message.content === 'string' ? message.content : JSON.stringify(message.content),
    )
    .join('\n');
  const named = ['Write', 'Read', 'Bash'].filter((tool) => systemText.includes(`### ${tool}`));
  check(
    'инструменты клиента доехали до модели текстом, поимённо',
    named.length === 3 && systemText.includes('<tool_call>'),
    `названы: ${named.join(', ') || 'ни одного'}`,
  );

  // ── 4. История цела ──────────────────────────────────────────────────────
  // Мост не переносит `tool_use`/`tool_result`: без текстовой записи агент не
  // видит ни своего вызова, ни его результата — и делает всё заново.
  //
  // Искать здесь просто тег результата НЕЛЬЗЯ: сам текст протокола показывает
  // модели ПРИМЕР ответа (`<tool_result name="Write">ok: 240 bytes written`), и
  // такая проверка зеленела бы на первом же запросе, где никакого вызова ещё не
  // было. Настоящий результат опознаётся именем нашего файла внутри блока.
  const blocksOf = (raw) =>
    [...raw.matchAll(/<tool_result name=\\"Write\\">(.*?)<\/tool_result>/g)].map((match) =>
      match[1].replace(/\\n/g, ' '),
    );
  const real = upstream
    .flatMap((call) => blocksOf(call.raw))
    .find((text) => text.includes(FILE_NAME));
  check(
    'результат вызова вернулся наверх текстом протокола',
    Boolean(real),
    `блоки результата: ${JSON.stringify(upstream.flatMap((call) => blocksOf(call.raw)))}`,
  );
  check(
    'в первом запросе такого блока ещё нет — значит нашли результат, а не пример из промпта',
    !blocksOf(upstream[0].raw).some((text) => text.includes(FILE_NAME)),
    JSON.stringify(blocksOf(upstream[0].raw)),
  );

  // ── 5–6. Что об этом знает панель ────────────────────────────────────────
  const status = await gatewayStatus();
  const events = (status.events ?? []).filter((item) => item.platformId === CONTOUR);
  // Разбор следа целиком: без него «вызовов 0» не отличить от «запрос не
  // дошёл», а чинятся эти два случая в разных местах.
  const trace = events.map((item) => ({
    at: item.at,
    path: item.path,
    status: item.status,
    error: item.error,
    shimmed: item.shimmed,
    calls: item.toolCalls,
    flaws: item.toolFlaws,
    claimed: item.claimedWithoutCall,
  }));
  check(
    'след запроса называет инструменты уехавшими текстом, а не потерянными',
    events.some((item) => (item.shimmed ?? []).includes('tools')) &&
      events.every((item) => !(item.lost ?? []).some((entry) => entry.includes('tools'))),
    JSON.stringify(trace),
  );
  check(
    'ход с вызовом посчитан карточкой «Инструменты через контур»',
    (status.toolShim?.calls ?? 0) >= 1 && (status.toolShim?.turns ?? 0) >= 1,
    `${JSON.stringify(status.toolShim)}\n    след: ${JSON.stringify(trace)}`,
  );

  // Цена хода — число для справки, а не проверка: оно меняется с каждой версией
  // CLI, и красный свип из-за чужого релиза никому не помогает.
  const turnBytes = Buffer.byteLength(upstream[0].raw, 'utf8');
  const listAt = systemText.indexOf('Список инструментов:');
  console.log(
    `\n  Замерено этим прогоном (числа для справки): инструментов ${
      (systemText.match(/^### /gm) ?? []).length
    }, перечень схем ${listAt >= 0 ? systemText.length - listAt : 0} знаков, ` +
      `весь системный текст ${systemText.length} знаков, запрос наверх ${Math.round(
        turnBytes / 1024,
      )} КБ на каждом ходе.\n`,
  );

  // ── 7. Две другие живые формы ответа ─────────────────────────────────────
  // Грамматику приёма расширяли из-за живого замера, а проверялась она до сих
  // пор только строками в модульном тесте. Обе формы решают противоположные
  // вопросы, и обе решаются одним правилом «весь ответ и есть вызов», поэтому
  // прогонять их надо ПАРОЙ: без второй первая — разрешение писать файлы
  // человека из любого куска текста.
  console.log('Прогон 3: ответ — один забор без метки, вызов обязан дойти…');
  const loose = await runClaude(exe, port, 'loose', 'stub-tool-loose');
  check(
    'ответ, который ЦЕЛИКОМ забор без метки, доводит вызов до файла',
    loose.created && loose.content.includes(EXPECTED),
    `код ${loose.code}, файл ${loose.created ? 'есть' : 'НЕ создан'}: ${loose.out.slice(-400)}`,
  );

  console.log('Прогон 4: пример протокола в заборе — файла быть НЕ должно…');
  const seen = new Set(((await gatewayStatus()).events ?? []).map((item) => item.at));
  const quote = await runClaude(exe, port, 'quote', 'stub-tool-quote');
  // Настоящий `claude.exe` однажды записал файл ровно из такого блока — из
  // того, про который модель прямым текстом написала «не выполняй, это пример».
  check(
    'цитата протокола в заборе НЕ трогает файл человека',
    !quote.created,
    `файл создан из примера: ${quote.content}`,
  );
  const quoteEvents = ((await gatewayStatus()).events ?? []).filter(
    (item) => item.platformId === CONTOUR && !seen.has(item.at),
  );
  // Молчать об этом нельзя: карточка сказала бы «вызовов не было» там, где
  // модель их писала, и человек пошёл бы чинить панель вместо промпта.
  check(
    'и человеку сказано, ПОЧЕМУ вызова не вышло',
    quoteEvents.some((item) =>
      (item.toolFlaws ?? []).some((reason) => reason.includes('внутри блока кода')),
    ),
    JSON.stringify(quoteEvents.map((item) => ({ calls: item.toolCalls, flaws: item.toolFlaws }))),
  );

  // ── 8. Та же дорога с выключенной прослойкой ─────────────────────────────
  console.log('Прогон 5: прослойка выключена — файла быть не должно…');
  const offPort = await openGateway(stub, false);
  const second = await runClaude(exe, offPort, 'off');
  check(
    'без прослойки тот же прогон файла НЕ создаёт',
    !second.created,
    `файл создан, хотя прослойка выключена: ${second.content}`,
  );
  const offStatus = await gatewayStatus();
  const offEvent = (offStatus.events ?? []).find((item) => item.platformId === CONTOUR);
  check(
    'и потеря инструментов при этом названа человеку',
    (offEvent?.lost ?? []).some((item) => item.includes('tools')),
    JSON.stringify(offEvent?.lost ?? []),
  );

  await runNative(stub, exe);
}

/**
 * ── 9. Совместимый шлюз: инструменты ПОЛЕМ (аудит DRV-01) ─────────────────
 *
 * Прослойка выключена, драйвер `openai-compat` объявляет `clientTools: 'native'`,
 * модель отвечает полем `tool_calls`. До правки мост выбрасывал `tools` у любого
 * драйвера: этот же прогон кончался без файла, а стаб звал инструмент заново,
 * потому что роль `tool` до него не доезжала.
 */
async function runNative(stub, exe) {
  const contour = 'native-compat';
  const model = 'stub-tool-native';
  console.log('Прогон 6: совместимый шлюз, инструменты полем…');
  const port = await openGateway(stub, false, contour, 'openai-compat');
  const before = stub.calls.length;
  const seen = new Set(((await gatewayStatus()).events ?? []).map((item) => item.at));
  const native = await runClaude(exe, port, 'native', model, contour);

  check(
    'настоящий CLI создал файл по вызову, пришедшему полем `tool_calls`',
    native.created && native.content.includes('руки полем'),
    `код ${native.code}, файл ${native.created ? 'есть' : 'НЕ создан'}: ${native.out.slice(-400)}`,
  );

  const upstream = stub.calls
    .slice(before)
    .filter((call) => call.path.endsWith('/chat/completions'))
    .map((call) => JSON.parse(call.body || '{}'))
    .filter((json) => json.model === model);
  const first = upstream[0] ?? {};
  const names = (first.tools ?? []).map((tool) => tool.function?.name);
  check(
    'наверх ушли схемы клиента полем `tools`, поимённо',
    ['Write', 'Read', 'Bash'].every((name) => names.includes(name)) &&
      first.tools.every((tool) => tool.type === 'function' && tool.function?.parameters),
    `инструменты: ${JSON.stringify(names)}`,
  );
  check(
    'текста протокола прослойки в запросе нет',
    upstream.every((json) => !JSON.stringify(json.messages ?? []).includes('<tool_call>')),
    'в сообщениях найден текст протокола',
  );
  const followUp = upstream.find((json) =>
    (json.messages ?? []).some((message) => message.role === 'tool'),
  );
  const toolAt = (followUp?.messages ?? []).findIndex((message) => message.role === 'tool');
  const callMessage = followUp?.messages?.[toolAt - 1];
  check(
    'результат вернулся ролью `tool` сразу за репликой с вызовом',
    Boolean(followUp) &&
      followUp.messages[toolAt].tool_call_id === 'call_native_1' &&
      (callMessage?.tool_calls ?? []).some((call) => call.id === 'call_native_1'),
    JSON.stringify((followUp?.messages ?? []).map((message) => message.role)),
  );

  const events = ((await gatewayStatus()).events ?? []).filter(
    (item) => item.platformId === contour && !seen.has(item.at),
  );
  check(
    'след: инструменты не потеряны и не «текстом», вызов посчитан рукой агента',
    events.every((item) => !(item.lost ?? []).includes('tools')) &&
      events.every((item) => (item.shimmed ?? []).length === 0) &&
      events.some((item) => (item.nativeCalls ?? 0) >= 1),
    JSON.stringify(
      events.map((item) => ({
        lost: item.lost,
        shimmed: item.shimmed,
        native: item.nativeCalls,
        contour: item.contourCalls,
        flaws: item.toolFlaws,
      })),
    ),
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
