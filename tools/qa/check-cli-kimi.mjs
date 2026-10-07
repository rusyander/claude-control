/**
 * Kimi Code в чате панели — настоящий `kimi` (2.1.1) через настоящую панель.
 *
 * Одноразовые стенды (`throwaway-stand.mjs`, только API) с активным kimi;
 * дом CLI — `KIMI_CODE_HOME` внутри стенда, его `config.toml` ведёт модель в
 * заглушку ниже (сетевая граница). Заглушка первым ответом зовёт `Write` —
 * ДАЖЕ если CLI его модели не показал: проверяется, что CLI сам не даст
 * записать, а не что модель послушная. Вторым — отдаёт заготовленный текст с
 * отступом и маркером в начале строки (на нём ломалось бы снятие оформления).
 *
 * Что доказывается:
 *   A. живой ход (`kimi web`): правки выключены — просьба о разрешении пришла
 *      человеку, «Запретить» → файл не тронут; включены — вопроса нет, файл
 *      записан; ответ — ровно текст заглушки, транспорт `live`;
 *   B. одиночный запуск (`kimi -p`, живой сервер на этом стенде не поднимается —
 *      обёртка отказывает подкоманде `web`, всё прочее отдаёт настоящему CLI):
 *      выключены — в argv `--agent-file` с профилем «только чтение», модели не
 *      показан ни Write/Edit/Bash, файл не тронут; включены — argv прежний, файл
 *      записан; ответ — ровно текст заглушки без `• ` и отступа, транспорт `stream`;
 *   C. настоящие каталоги CLI человека не тронуты (снимок до/после);
 *   D. без kimi в PATH и с ключом `KIMI_API_KEY` прямой вызов API идёт ровно на
 *      `https://api.moonshot.ai/v1/chat/completions` (адрес вендора из каталога),
 *      а не на `OPENAI_BASE_URL` и не в OpenAI. Сеть подменена: запрос вне машины
 *      записывается обёрткой `fetch` и наружу не уходит.
 *
 * Заметка без провала (`--gap`): живой ход при `default_permission_mode = "auto"`
 * в конфиге человека — Kimi не спрашивает, и выключенный переключатель на живом
 * пути не действует. Печатается то, что увидели, для решения владельца.
 *
 * `kimi` — из `KIMI_CLI_DIR` / `STEER_CLI_DIR` (каталоги через разделитель PATH),
 * иначе из PATH. Нет его — «не проверено» (код 2), не провал.
 * Код выхода: 0 — сходится, 1 — провал, 2 — не проверено.
 */
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  NotChecked,
  REAL_HOME,
  diffRealProviderDirs,
  realProviderDirs,
  reporter,
  snapshotRealProviderDirs,
  startStand,
  wait,
} from './throwaway-stand.mjs';

const IS_WIN = process.platform === 'win32';
const CANNED = 'KIMI_STUB_CANNED_7c1e\n    code line\n• bullet line';
const PROBE = 'kimi-probe.txt';
const ORIGINAL = 'original-content';
const WRITTEN = 'written-by-kimi';
const EDIT_TOOLS = ['Write', 'Edit', 'Bash'];
const GAP = process.argv.includes('--gap');

function findCliDir() {
  const names = IS_WIN ? ['kimi.exe', 'kimi.cmd', 'kimi'] : ['kimi'];
  const dirs = [
    ...(process.env.KIMI_CLI_DIR ? process.env.KIMI_CLI_DIR.split(delimiter) : []),
    ...(process.env.STEER_CLI_DIR ? process.env.STEER_CLI_DIR.split(delimiter) : []),
    ...(process.env.PATH ?? process.env.Path ?? '').split(delimiter),
  ];
  return dirs.find((dir) => dir && names.some((file) => existsSync(join(dir, file))));
}

/** PID процессов из каталога CLI — снимаем после прогона только появившиеся. */
function cliProcesses(dir) {
  const norm = (text) => text.toLowerCase().replace(/[\\/]+/g, '/');
  const needle = norm(dir).replace(/\/+$/, '');
  try {
    const rows = IS_WIN
      ? execFileSync(
          'powershell',
          [
            '-NoProfile',
            '-Command',
            'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId)`t$($_.CommandLine)" }',
          ],
          { encoding: 'utf8' },
        )
      : execFileSync('ps', ['-eo', 'pid=,args='], { encoding: 'utf8' });
    return new Set(
      rows
        .split(/\r?\n/)
        .map((row) => row.trim().match(/^(\d+)\s+(.*)$/))
        .filter((match) => match && norm(match[2]).includes(needle))
        .map((match) => Number(match[1])),
    );
  } catch {
    return new Set();
  }
}

/** Заглушка OpenAI `/chat/completions` (поток SSE) с журналом запросов. */
function startStub() {
  const requests = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      if (!req.url.includes('chat/completions')) {
        requests.push({ url: req.url, other: true });
        res.writeHead(404);
        res.end('{}');
        return;
      }
      let parsed = {};
      try {
        parsed = JSON.parse(body);
      } catch {
        // не JSON — пусть будет пустой запрос
      }
      const tools = (parsed.tools ?? []).map((tool) => tool.function?.name);
      const toolResults = (parsed.messages ?? [])
        .filter((message) => message.role === 'tool')
        .map((message) =>
          typeof message.content === 'string' ? message.content : JSON.stringify(message.content),
        );
      // Без результата инструмента — зовём Write, даже если его не показали.
      const call = toolResults.length === 0;
      requests.push({ tools, call, toolResults, model: parsed.model });

      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      const send = (delta, finish = null) =>
        res.write(
          `data: ${JSON.stringify({
            id: 'stub',
            object: 'chat.completion.chunk',
            created: 1,
            model: 'stub-model',
            choices: [{ index: 0, delta, finish_reason: finish }],
          })}\n\n`,
        );
      if (call) {
        send({
          role: 'assistant',
          tool_calls: [
            {
              index: 0,
              id: `call_${requests.length}`,
              type: 'function',
              function: {
                name: 'Write',
                arguments: JSON.stringify({ path: PROBE, content: WRITTEN }),
              },
            },
          ],
        });
        send({}, 'tool_calls');
      } else {
        send({ role: 'assistant', content: CANNED });
        send({}, 'stop');
      }
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });
  return new Promise((done) =>
    server.listen(0, '127.0.0.1', () =>
      done({
        port: server.address().port,
        requests,
        close: () =>
          new Promise((closed) => {
            server.closeAllConnections();
            server.close(() => closed());
          }),
      }),
    ),
  );
}

const configText = (port, mode) =>
  [
    'default_model = "stub"',
    ...(mode ? [`default_permission_mode = "${mode}"`] : []),
    '[providers.stub]',
    'type = "openai"',
    `base_url = "http://127.0.0.1:${port}/v1"`,
    'api_key = "x"',
    '[models.stub]',
    'provider = "stub"',
    'model = "stub-model"',
    'max_context_size = 128000',
    '',
  ].join('\n');

/**
 * Обёртка «kimi без живого сервера»: подкоманда `web` падает (живой путь
 * панели честно недоступен → одиночный запуск), всё прочее — настоящему CLI;
 * argv каждого вызова — строкой JSON в журнал.
 */
const wrapperSource = (real, argvLog) => `
import { appendFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(argvLog)}, JSON.stringify(args) + '\\n');
if (args[0] === 'web') {
  process.stderr.write('web отключён проверкой\\n');
  process.exit(1);
}
const result = spawnSync(${JSON.stringify(real)}, args, { stdio: 'inherit', windowsHide: true });
process.exit(result.status ?? 1);
`;

/**
 * Каталог с обёрткой под именем `kimi`. На Windows — `.cmd` в форме pnpm/старого
 * npm (`node "%~dp0\\<скрипт>" %*`): её панель узнаёт и запускает node напрямую,
 * без cmd.exe, иначе многострочный промпт честно отклоняется (`win-shim.ts`).
 * Обёртка стенда (`fakeCli`) пишет абсолютный путь node — такую панель не узнаёт.
 */
function wrapperDir(real, argvLog) {
  const dir = mkdtempSync(join(tmpdir(), 'cc-kimi-wrap-'));
  writeFileSync(join(dir, 'kimi-wrapper.mjs'), wrapperSource(real, argvLog), 'utf8');
  if (IS_WIN) {
    writeFileSync(join(dir, 'kimi.cmd'), '@echo off\r\nnode "%~dp0\\kimi-wrapper.mjs" %*\r\n');
  } else {
    writeFileSync(
      join(dir, 'kimi'),
      `#!/bin/sh\nexec "${process.execPath}" "${join(dir, 'kimi-wrapper.mjs')}" "$@"\n`,
      { mode: 0o755 },
    );
  }
  return dir;
}

const cliDir = findCliDir();
if (!cliDir) {
  console.log('Не проверено: `kimi` (Kimi Code) не найден — задайте KIMI_CLI_DIR.');
  process.exit(2);
}
const realKimi = join(cliDir, IS_WIN ? 'kimi.exe' : 'kimi');
const { check, finish, failed } = reporter();
const stub = await startStub();
// Каталоги CLI человека, кроме Claude (его пишет живая сессия человека, а
// kimi-стенд `noClaude` к нему не прикасается), плюс `~/.kimi-code` — дом
// Kimi Code 2.1.1 (общий список знает только прежний `~/.kimi`).
const realDirs = [
  ...realProviderDirs().filter((dir) => !/[\\/]\.claude[^\\/]*$/.test(dir)),
  join(REAL_HOME, '.kimi-code'),
];
const realBefore = snapshotRealProviderDirs({ dirs: realDirs });
const pidsBefore = cliProcesses(cliDir);
let notChecked;

const until = async (probe, seconds) => {
  for (let i = 0; i < seconds * 4; i += 1) {
    const value = await probe();
    if (value) return value;
    await wait(250);
  }
  return undefined;
};

/**
 * Один стенд: свой дом kimi (`KIMI_CODE_HOME` — временный каталог, настоящий
 * `~/.kimi-code` не участвует), разговор на каталог, ход с переключателем.
 */
async function stand(label, options, scenario) {
  const kimiHome = mkdtempSync(join(tmpdir(), 'cc-kimi-home-'));
  writeFileSync(join(kimiHome, 'config.toml'), configText(stub.port), 'utf8');
  let panel;
  try {
    panel = await startStand({
      label,
      web: false,
      noClaude: true,
      settings: { provider: 'kimi' },
      env: { KIMI_CODE_HOME: kimiHome },
      ...options,
    });
  } catch (error) {
    rmSync(kimiHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
    if (error instanceof NotChecked) {
      notChecked = error.message;
      console.log(`  Не проверено: ${notChecked}`);
      return;
    }
    throw error;
  }
  try {
    const cli = await panel.api('/chat/cli?provider=kimi&refresh=1');
    if (cli.status !== 200 || !(cli.body?.installs?.length > 0)) {
      notChecked = `панель не видит kimi: ${cli.text.slice(0, 300)}`;
      console.log(`  Не проверено: ${notChecked}`);
      return;
    }
    const project = (name) => {
      const dir = join(panel.root, 'work', name);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, PROBE), ORIGINAL, 'utf8');
      return dir;
    };
    const runTurn = async (dir, allowEdits, onAsk) => {
      const created = await panel.api('/provider-chat/chats', {
        method: 'POST',
        body: { workdir: dir },
      });
      if (created.status !== 200) throw new Error(`разговор не создан: ${created.text}`);
      const id = created.body.id;
      const patched = await panel.api(`/provider-chat/chats/${id}`, {
        method: 'PATCH',
        body: { allowEdits },
      });
      check(`allowEdits=${allowEdits} записан`, patched.status === 200, patched.text);
      const from = stub.requests.length;
      const sent = await panel.api(`/provider-chat/chats/${id}/send`, {
        method: 'POST',
        body: { text: `Запиши ${PROBE}.` },
      });
      check('вопрос принят', sent.status === 200, sent.text);
      const asks = [];
      const done = await until(async () => {
        const status = (await panel.api(`/provider-chat/chats/${id}/status`)).body;
        for (const ask of status?.permissions ?? []) {
          if (asks.some((seen) => seen.id === ask.id)) continue;
          asks.push(ask);
          const decision = onAsk ? onAsk(ask) : 'deny';
          await panel.api(`/provider-chat/chats/${id}/permissions/${ask.id}`, {
            method: 'POST',
            body: { decision },
          });
        }
        return status?.isRunning === false;
      }, 180);
      check('ход кончился', Boolean(done));
      const messages = (await panel.api(`/provider-chat/chats/${id}`)).body?.messages ?? [];
      return { messages, asks, requests: stub.requests.slice(from), dir };
    };
    await scenario({ project, runTurn, kimiHome });
  } finally {
    await panel.stop();
    rmSync(kimiHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  }
}

/**
 * D1 живьём: стенд без kimi в PATH, ключ-метка в `KIMI_API_KEY`, `OPENAI_BASE_URL`
 * смотрит на ловушку проверки, а `NODE_OPTIONS=--import` подкладывает панели
 * обёртку `fetch`: запрос вне 127.0.0.1 записывается и наружу НЕ уходит (599).
 * Подменена только сеть. Ждём ровно один запрос — на адрес Moonshot, с меткой.
 */
async function checkVendorApi() {
  const sentinel = `qa-kimi-key-${Math.random().toString(36).slice(2, 8)}`;
  const trapHits = [];
  const trap = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      trapHits.push({ path: req.url, headers: req.headers, body: raw });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: 'TRAP_REPLY' } }] }));
    });
  });
  await new Promise((done) => trap.listen(0, '127.0.0.1', done));
  const work = mkdtempSync(join(tmpdir(), 'cc-kimi-d1-'));
  const offBoxLog = join(work, 'off-box.jsonl');
  const preload = join(work, 'fetch-trap.mjs');
  writeFileSync(
    preload,
    `import { appendFileSync } from 'node:fs';
const real = globalThis.fetch;
globalThis.fetch = async (input, init = {}) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const host = new URL(url).hostname;
  if (['127.0.0.1', 'localhost', '::1', '[::1]'].includes(host)) return real(input, init);
  const h = init.headers;
  const headers = !h ? {} : typeof h.entries === 'function' ? Object.fromEntries(h.entries()) : { ...h };
  appendFileSync(${JSON.stringify(offBoxLog)}, JSON.stringify({ url, headers }) + '\\n');
  return new Response('{"error":"qa trap: off-box request"}', { status: 599 });
};
`,
    'utf8',
  );
  let panel;
  try {
    panel = await startStand({
      label: 'cli-kimi-d1',
      web: false,
      noClaude: true,
      settings: { provider: 'kimi' },
      env: {
        KIMI_API_KEY: sentinel,
        OPENAI_BASE_URL: `http://127.0.0.1:${trap.address().port}/v1`,
        NODE_OPTIONS: `--import=${pathToFileURL(preload).href}`,
      },
    });
    const runner = (await panel.api('/provider-runner')).body;
    check(
      `kimi в PATH стенда нет (раннер ${runner?.mode}/${runner?.reason})`,
      runner?.cliFound === false,
      JSON.stringify(runner).slice(0, 300),
    );
    const created = await panel.api('/provider-chat/chats', { method: 'POST', body: {} });
    if (created.status !== 200) throw new Error(`разговор не создан: ${created.text}`);
    const id = created.body.id;
    const sent = await panel.api(`/provider-chat/chats/${id}/send`, {
      method: 'POST',
      body: { text: 'вопрос через API' },
    });
    check('вопрос принят', sent.status === 200, sent.text.slice(0, 300));
    await until(
      async () => (await panel.api(`/provider-chat/chats/${id}/status`)).body?.isRunning === false,
      30,
    );
    const offBox = existsSync(offBoxLog)
      ? readFileSync(offBoxLog, 'utf8')
          .split('\n')
          .filter(Boolean)
          .map((row) => JSON.parse(row))
      : [];
    const carried = offBox.filter((hit) => JSON.stringify(hit.headers).includes(sentinel));
    check(
      'ключ ушёл ровно одним запросом на https://api.moonshot.ai/v1/chat/completions',
      carried.length === 1 && carried[0].url === 'https://api.moonshot.ai/v1/chat/completions',
      JSON.stringify(offBox.map((hit) => hit.url)),
    );
    check(
      'ловушка OPENAI_BASE_URL не получила ни одного запроса',
      trapHits.length === 0,
      JSON.stringify(trapHits.map((hit) => hit.path)),
    );
  } catch (error) {
    if (error instanceof NotChecked) {
      notChecked = error.message;
      console.log(`  Не проверено: ${notChecked}`);
    } else throw error;
  } finally {
    if (panel) await panel.stop();
    await new Promise((done) => trap.close(() => done()));
    rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  }
}

const fileIs = (dir) => readFileSync(join(dir, PROBE), 'utf8').trim();
const answerOf = (turn) => turn.messages.at(-1);
const answerChecks = (turn, transport) => {
  const answer = answerOf(turn);
  check(
    'ответ — ровно текст заглушки (без `• ` и отступа стенограммы)',
    answer?.role === 'assistant' && answer.content === CANNED,
    JSON.stringify(answer?.content),
  );
  check(`транспорт ${transport}`, answer?.transport === transport, String(answer?.transport));
};

try {
  // ---- A. Живой ход.
  console.log(`kimi: ${realKimi}\n\nA. Живой ход (kimi web)`);
  await stand('cli-kimi-live', { extraPath: [cliDir] }, async ({ project, runTurn }) => {
    console.log('A1. «Разрешить правки» выключено');
    const off = await runTurn(project('live-off'), false, () => 'deny');
    check('просьба о разрешении дошла до человека', off.asks.length > 0, JSON.stringify(off.asks));
    check('файл не тронут после «Запретить»', fileIs(off.dir) === ORIGINAL, fileIs(off.dir));
    answerChecks(off, 'live');

    console.log('\nA2. «Разрешить правки» включено');
    const on = await runTurn(project('live-on'), true);
    check('вопроса человеку нет', on.asks.length === 0, JSON.stringify(on.asks));
    check('файл записан', fileIs(on.dir) === WRITTEN, fileIs(on.dir));
    answerChecks(on, 'live');
  });

  // ---- B. Одиночный запуск.
  console.log('\nB. Одиночный запуск (kimi -p, живой сервер недоступен)');
  const argvLog = join(tmpdir(), `kimi-argv-${process.pid}.log`);
  rmSync(argvLog, { force: true });
  const wrapDir = wrapperDir(realKimi, argvLog);
  await stand('cli-kimi-oneshot', { extraPath: [wrapDir] }, async ({ project, runTurn }) => {
    const promptCalls = () =>
      (existsSync(argvLog) ? readFileSync(argvLog, 'utf8') : '')
        .split('\n')
        .filter(Boolean)
        .map((row) => JSON.parse(row))
        .filter((args) => args.includes('-p'));

    console.log('B1. «Разрешить правки» выключено');
    const off = await runTurn(project('oneshot-off'), false);
    const offArgs = promptCalls().at(-1) ?? [];
    const agentFile = offArgs[offArgs.indexOf('--agent-file') + 1];
    check(
      'argv: `--agent-file` с профилем «только чтение»',
      offArgs.includes('--agent-file') && /kimi-read-only-agent\.md$/.test(agentFile ?? ''),
      JSON.stringify(offArgs.map((arg) => (arg.length > 80 ? `${arg.slice(0, 80)}…` : arg))),
    );
    const offTools = [...new Set(off.requests.flatMap((request) => request.tools ?? []))];
    check(
      'модели не показан ни Write, ни Edit, ни Bash',
      off.requests.length > 0 && !offTools.some((tool) => EDIT_TOOLS.includes(tool)),
      JSON.stringify(offTools),
    );
    check(
      'Write, позванный мимо списка, отклонён самим CLI',
      off.requests.some((request) => request.toolResults.some((text) => /not found/i.test(text))),
      JSON.stringify(off.requests.map((request) => request.toolResults)),
    );
    check('файл не тронут', fileIs(off.dir) === ORIGINAL, fileIs(off.dir));
    answerChecks(off, 'stream');

    console.log('\nB2. «Разрешить правки» включено');
    const on = await runTurn(project('oneshot-on'), true);
    const onArgs = promptCalls().at(-1) ?? [];
    check(
      'argv прежний: без `--agent-file`',
      !onArgs.includes('--agent-file'),
      JSON.stringify(onArgs.slice(0, 3)),
    );
    const onTools = [...new Set(on.requests.flatMap((request) => request.tools ?? []))];
    check('модели показан Write', onTools.includes('Write'), JSON.stringify(onTools));
    check('файл записан', fileIs(on.dir) === WRITTEN, fileIs(on.dir));
    answerChecks(on, 'stream');
  });
  rmSync(argvLog, { force: true });
  rmSync(wrapDir, { recursive: true, force: true });

  // ---- D. Без CLI — прямой вызов API ключом Kimi (D1).
  console.log('\nD. Без kimi в PATH: ключ KIMI_API_KEY уходит только в API Moonshot');
  await checkVendorApi();

  // ---- Заметка: живой ход при `auto` в конфиге человека.
  if (GAP) {
    console.log(
      '\nЗаметка (не проверка): живой ход, default_permission_mode = "auto", правки выключены',
    );
    await stand('cli-kimi-gap', { extraPath: [cliDir] }, async ({ project, runTurn, kimiHome }) => {
      writeFileSync(join(kimiHome, 'config.toml'), configText(stub.port, 'auto'), 'utf8');
      const gap = await runTurn(project('gap'), false, () => 'deny');
      console.log(
        `  вопросов человеку: ${gap.asks.length}; файл: ${fileIs(gap.dir) === WRITTEN ? 'ЗАПИСАН' : 'не тронут'}`,
      );
    });
  }

  // ---- C. Настоящие каталоги.
  console.log('\nC. Настоящие каталоги CLI человека');
  const changed = diffRealProviderDirs(realBefore, snapshotRealProviderDirs({ dirs: realDirs }));
  check('не тронуты (снимок до/после)', changed.length === 0, JSON.stringify(changed.slice(0, 10)));
} catch (error) {
  check('сценарий дошёл до конца', false, error?.stack ?? String(error));
} finally {
  await stub.close();
  for (const pid of cliProcesses(cliDir)) {
    if (pidsBefore.has(pid) || pid === process.pid) continue;
    try {
      process.kill(pid);
    } catch {
      // уже вышел
    }
  }
}

if (notChecked && failed() === 0) {
  console.log(`\nНе проверено: ${notChecked}`);
  process.exit(2);
}
finish();
