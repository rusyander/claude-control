/**
 * Goose в чате панели — настоящий `goose` (1.53) через настоящую панель.
 *
 * Одноразовые стенды (`throwaway-stand.mjs`, только API) с активным goose; дом
 * Goose — `%APPDATA%\Block\goose` внутри дома стенда, в его `config.yaml`
 * записан `GOOSE_MODE: auto` (умолчание Goose: всё без вопросов). Модель —
 * заглушка OpenAI `/chat/completions` ниже (сетевая граница): первым ответом
 * зовёт инструмент-оболочку, пишущую файл-метку, ДАЖЕ если CLI инструментов не
 * показал (проверяется CLI, а не послушная модель); вторым — заготовленный текст
 * несколькими кусками потока, с отступом в последней строке.
 *
 * Что доказывается:
 *   A. живой ход (`goose acp`): правки выключены — панель переводит сессию в
 *      `approve`, просьба о разрешении дошла до человека, «Запретить» → файла
 *      нет; включены — вопроса нет, файл записан; ответ — ровно текст
 *      заглушки, транспорт `live`; `config.yaml` человека не тронут (режим
 *      живёт в сессии);
 *   B. одиночный запуск (`goose run`, живой путь недоступен — обёртка отказывает
 *      подкоманде `acp`, всё прочее отдаёт настоящему CLI): argv несёт `-q` и
 *      `--output-format stream-json`; выключены — `GOOSE_MODE=chat`, файла нет;
 *      включены — `GOOSE_MODE=auto`, файл записан; ответ — ровно текст заглушки
 *      без баннера и `▸ shell`, транспорт `stream`;
 *   S. скилл, записанный разделом панели (глобальный и проектный), виден самому
 *      Goose: `goose skills list` в каталоге проекта называет оба;
 *   C. настоящие каталоги CLI человека не тронуты (снимок до/после).
 *
 * `goose` — из `GOOSE_CLI_DIR` / `STEER_CLI_DIR` (каталоги через разделитель
 * PATH), иначе из PATH. Нет его — «не проверено» (код 2), не провал.
 * Код выхода: 0 — сходится, 1 — провал, 2 — не проверено.
 */
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
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
const CANNED_PARTS = ['GOOSE_STUB_CANNED_5d2a ', 'вторая часть\n', '    строка с отступом'];
const CANNED = CANNED_PARTS.join('');
const PROBE = 'goose-probe.txt';
const WRITTEN = 'GOOSE_WROTE';
const USER_MODE = 'GOOSE_MODE: auto\n';
const TOKEN = Math.random().toString(36).slice(2, 8);

function findCliDir() {
  const names = IS_WIN ? ['goose.exe', 'goose.cmd', 'goose'] : ['goose'];
  const dirs = [
    ...(process.env.GOOSE_CLI_DIR ? process.env.GOOSE_CLI_DIR.split(delimiter) : []),
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

/**
 * Заглушка OpenAI `/chat/completions` (поток SSE) с журналом запросов. Вызов
 * оболочки — на запрос, где в тексте есть путь-метка и ещё нет результата
 * инструмента; служебные запросы Goose (имя сессии) метки не несут.
 */
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
      const target = body.match(/QA-TARGET<([^>]+)>/)?.[1]?.replaceAll('\\\\', '\\');
      const call = Boolean(target) && toolResults.length === 0;
      const shell = tools.find((name) => /(^|__)shell$/.test(name ?? '')) ?? 'shell';
      requests.push({ tools, call, toolResults, target });

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
                name: shell,
                arguments: JSON.stringify({ command: `echo ${WRITTEN}> "${target}"` }),
              },
            },
          ],
        });
        send({}, 'tool_calls');
      } else {
        send({ role: 'assistant', content: CANNED_PARTS[0] });
        for (const part of CANNED_PARTS.slice(1)) send({ content: part });
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

/**
 * Обёртка «goose без живого сервера»: подкоманда `acp` падает (живой путь
 * панели честно недоступен → одиночный запуск), всё прочее — настоящему CLI;
 * argv и GOOSE_MODE каждого вызова — строкой JSON в журнал.
 */
const wrapperSource = (real, argvLog) => `
import { appendFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(argvLog)}, JSON.stringify({ args, mode: process.env.GOOSE_MODE ?? null }) + '\\n');
if (args[0] === 'acp') {
  process.stderr.write('acp отключён проверкой\\n');
  process.exit(2);
}
const result = spawnSync(${JSON.stringify(real)}, args, { stdio: 'inherit', windowsHide: true });
process.exit(result.status ?? 1);
`;

const cliDir = findCliDir();
if (!cliDir) {
  console.log('Не проверено: `goose` не найден — задайте GOOSE_CLI_DIR.');
  process.exit(2);
}
const realGoose = join(cliDir, IS_WIN ? 'goose.exe' : 'goose');
const { check, finish, failed } = reporter();
const stub = await startStub();
// Каталоги CLI человека без `~/.claude*` (его пишет живая сессия человека), но
// с `~/.claude/skills`: Goose на Windows читает его мимо HOME стенда — читать
// можно, менять нельзя.
const realDirs = [
  ...realProviderDirs().filter((dir) => !/[\\/]\.claude[^\\/]*$/.test(dir)),
  join(REAL_HOME, '.claude', 'skills'),
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

const gooseConfig = (home) =>
  IS_WIN
    ? join(home, 'AppData', 'Roaming', 'Block', 'goose', 'config')
    : join(home, '.config', 'goose');

/** Один стенд: дом Goose в доме стенда, модель — заглушка, ключ — переменной. */
async function stand(label, options, scenario) {
  let panel;
  try {
    panel = await startStand({
      label,
      web: false,
      settings: { provider: 'goose' },
      env: {
        GOOSE_PROVIDER: 'openai',
        GOOSE_MODEL: 'stub-model',
        OPENAI_HOST: `http://127.0.0.1:${stub.port}`,
        OPENAI_BASE_PATH: 'v1/chat/completions',
        OPENAI_API_KEY: 'x',
        GOOSE_DISABLE_KEYRING: '1',
        GOOSE_TELEMETRY_ENABLED: 'false',
      },
      seed: ({ home }) => {
        mkdirSync(gooseConfig(home), { recursive: true });
        writeFileSync(join(gooseConfig(home), 'config.yaml'), USER_MODE, 'utf8');
      },
      ...options,
    });
  } catch (error) {
    if (error instanceof NotChecked) {
      notChecked = error.message;
      console.log(`  Не проверено: ${notChecked}`);
      return;
    }
    throw error;
  }
  try {
    const cli = await panel.api('/chat/cli?provider=goose&refresh=1');
    if (cli.status !== 200 || !(cli.body?.installs?.length > 0)) {
      notChecked = `панель не видит goose: ${cli.text.slice(0, 300)}`;
      console.log(`  Не проверено: ${notChecked}`);
      return;
    }
    const project = (name) => {
      const dir = join(panel.root, 'work', name);
      mkdirSync(dir, { recursive: true });
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
        body: { text: `Запиши файл QA-TARGET<${join(dir, PROBE)}>.` },
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
    await scenario({ panel, project, runTurn });
  } finally {
    await panel.stop();
  }
}

const probeOf = (dir) =>
  existsSync(join(dir, PROBE)) ? readFileSync(join(dir, PROBE), 'utf8').trim() : null;
const answerChecks = (turn, transport) => {
  const answer = turn.messages.at(-1);
  check(
    'ответ — ровно текст заглушки (без баннера и `▸ shell`)',
    answer?.role === 'assistant' && answer.content === CANNED,
    JSON.stringify(answer?.content),
  );
  check(`транспорт ${transport}`, answer?.transport === transport, String(answer?.transport));
};
const askedTool = (turn) => turn.requests.some((request) => request.call);

try {
  // ---- A. Живой ход.
  console.log(`goose: ${realGoose}\n\nA. Живой ход (goose acp), в config.yaml GOOSE_MODE: auto`);
  await stand('cli-goose-live', { extraPath: [cliDir] }, async ({ panel, project, runTurn }) => {
    console.log('A1. «Разрешить правки» выключено');
    const off = await runTurn(project('live-off'), false, () => 'deny');
    check('модель позвала оболочку', askedTool(off), JSON.stringify(off.requests));
    check('просьба о разрешении дошла до человека', off.asks.length > 0, JSON.stringify(off.asks));
    check('файла нет после «Запретить»', probeOf(off.dir) === null, String(probeOf(off.dir)));
    answerChecks(off, 'live');

    console.log('\nA2. «Разрешить правки» включено');
    const on = await runTurn(project('live-on'), true);
    check('модель позвала оболочку', askedTool(on), JSON.stringify(on.requests));
    check('вопроса человеку нет', on.asks.length === 0, JSON.stringify(on.asks));
    check('файл записан', probeOf(on.dir) === WRITTEN, String(probeOf(on.dir)));
    answerChecks(on, 'live');

    const config = readFileSync(join(gooseConfig(panel.home), 'config.yaml'), 'utf8');
    check(
      'config.yaml человека не тронут (режим — в сессии)',
      config === USER_MODE,
      JSON.stringify(config),
    );

    // ---- S. Скиллы: записаны панелью — видны Goose.
    console.log('\nS. Скиллы раздела панели видны самому Goose');
    const globalName = `qa-goose-global-${TOKEN}`;
    const projectName = `qa-goose-project-${TOKEN}`;
    const draft = (name) => ({
      path: `${name}/SKILL.md`,
      name,
      description: `Проверочный скилл ${name}`,
      body: 'Тело проверочного скилла.\n',
    });
    const savedGlobal = await panel.api('/provider-skills/skill', {
      method: 'PUT',
      body: draft(globalName),
    });
    check('глобальный скилл записан панелью', savedGlobal.status === 200, savedGlobal.text);
    const projectDir = project('skills');
    const added = await panel.api('/projects', { method: 'POST', body: { path: projectDir } });
    check('проект добавлен', added.status === 200 && added.body?.id, added.text);
    const savedProject = await panel.api(`/projects/${added.body?.id}/provider/skills/skill`, {
      method: 'PUT',
      body: draft(projectName),
    });
    check('проектный скилл записан панелью', savedProject.status === 200, savedProject.text);
    let listed;
    try {
      listed = execFileSync(realGoose, ['skills', 'list'], {
        cwd: projectDir,
        encoding: 'utf8',
        windowsHide: true,
        env: {
          PATH: process.env.PATH ?? process.env.Path,
          SYSTEMROOT: process.env.SYSTEMROOT ?? '',
          HOME: panel.home,
          USERPROFILE: panel.home,
          APPDATA: join(panel.home, 'AppData', 'Roaming'),
          LOCALAPPDATA: join(panel.home, 'AppData', 'Local'),
          GOOSE_DISABLE_KEYRING: '1',
        },
      });
    } catch (error) {
      listed = `${error.stdout ?? ''}${error.stderr ?? ''}`;
    }
    check('goose skills list: глобальный скилл виден', listed.includes(globalName), listed);
    check('goose skills list: проектный скилл виден', listed.includes(projectName), listed);
  });

  // ---- B. Одиночный запуск.
  console.log('\nB. Одиночный запуск (goose run, живой путь недоступен)');
  const argvLog = join(tmpdir(), `goose-argv-${process.pid}.log`);
  rmSync(argvLog, { force: true });
  // Обёртка — в форме старого npm (`node "%~dp0\<скрипт>" %*`): такую панель
  // разворачивает в прямой запуск node, и многострочный запрос доходит целиком.
  // Обёртка из `fakeCli` стенда — батник с абсолютным путём, его панель
  // справедливо отвергает.
  const shimDir = mkdtempSync(join(tmpdir(), 'cc-goose-shim-'));
  writeFileSync(join(shimDir, 'goose-noacp.mjs'), wrapperSource(realGoose, argvLog), 'utf8');
  if (IS_WIN) {
    writeFileSync(join(shimDir, 'goose.cmd'), '@node "%~dp0\\goose-noacp.mjs" %*\r\n', 'utf8');
  } else {
    writeFileSync(
      join(shimDir, 'goose'),
      `#!/bin/sh\nexec "${process.execPath}" "${join(shimDir, 'goose-noacp.mjs')}" "$@"\n`,
      { mode: 0o755 },
    );
  }
  await stand('cli-goose-oneshot', { extraPath: [shimDir] }, async ({ project, runTurn }) => {
    const runCalls = () =>
      (existsSync(argvLog) ? readFileSync(argvLog, 'utf8') : '')
        .split('\n')
        .filter(Boolean)
        .map((row) => JSON.parse(row))
        .filter((call) => call.args[0] === 'run');
    const argvChecks = (call) =>
      check(
        'argv: `run -q --output-format stream-json`',
        call?.args.includes('-q') &&
          call.args[call.args.indexOf('--output-format') + 1] === 'stream-json',
        JSON.stringify(call?.args.map((arg) => (arg.length > 80 ? `${arg.slice(0, 80)}…` : arg))),
      );

    console.log('B1. «Разрешить правки» выключено');
    const off = await runTurn(project('oneshot-off'), false);
    const offCall = runCalls().at(-1);
    argvChecks(offCall);
    check('GOOSE_MODE=chat', offCall?.mode === 'chat', String(offCall?.mode));
    check('модель позвала оболочку', askedTool(off), JSON.stringify(off.requests));
    check('файла нет', probeOf(off.dir) === null, String(probeOf(off.dir)));
    answerChecks(off, 'stream');

    console.log('\nB2. «Разрешить правки» включено');
    const on = await runTurn(project('oneshot-on'), true);
    const onCall = runCalls().at(-1);
    argvChecks(onCall);
    check('GOOSE_MODE=auto', onCall?.mode === 'auto', String(onCall?.mode));
    check('файл записан', probeOf(on.dir) === WRITTEN, String(probeOf(on.dir)));
    answerChecks(on, 'stream');
  });
  rmSync(argvLog, { force: true });
  rmSync(shimDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });

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
