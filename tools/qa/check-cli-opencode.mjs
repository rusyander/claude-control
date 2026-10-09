/**
 * OpenCode в чате панели — настоящим opencode через настоящую панель. Кейсы
 * cli-opencode-001 (сессия `serve`, права), -002 (одиночный `run`), -003 (ключ без CLI).
 *
 * Свой одноразовый стенд (`throwaway-stand.mjs`, без фронта и без Claude) и
 * заглушка модели (`stub-steer-model.mjs`): первым ответом она зовёт инструмент
 * оболочки строкой, пишущей файл в каталог разговора, после результата
 * инструмента отвечает текстом `NO_STEER`. Конфигурация OpenCode — свой файл
 * (`OPENCODE_CONFIG`) и свои XDG-каталоги во временном доме. Доказательство —
 * файл на диске, карточка в статусе разговора и argv, дошедший до процесса.
 *
 * Сессия (`opencode serve`):
 *   A. правки выключены, своих правил нет → карточка, «Запретить» → файла нет, ответ — текст модели;
 *   B. правки выключены → карточка, «Разрешить» → файл есть;
 *   C. правки включены → карточки нет, файл есть;
 *   D. в проекте `bash: deny`, правки включены → карточки нет, файла нет (запрет человека не ослаблен);
 *   E. в проекте `bash: allow`, правки выключены → карточки нет, файл есть (явное решение человека).
 * Одиночный запуск (`opencode run`; обёртка перед настоящим CLI отказывает `serve`):
 *   F. в проекте `bash: ask`, правки выключены → без `--auto`, файла нет, ход кончился сам;
 *   G. то же, правки включены → `--auto`, файл есть, ответ ровно текст модели (служебных строк нет).
 * Без CLI в PATH, ключ сохранён в панели:
 *   H. ответ — отказ `assistant-api-base-unknown`, ловушка `OPENAI_BASE_URL` не получила ничего.
 * И везде: настоящие каталоги провайдеров человека не тронуты (`snapshotRealProviderDirs`).
 *
 * Подменена только модель (сетевая граница). CLI — из `STEER_CLI_DIR` (каталоги
 * через разделитель PATH), иначе из PATH. Нет его — «не проверено», код 2.
 * Код выхода: 0 — всё сходится, 1 — провал, 2 — не проверено.
 */
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import {
  NotChecked,
  diffRealProviderDirs,
  reporter,
  snapshotRealProviderDirs,
  startStand,
  wait,
} from './throwaway-stand.mjs';
import { startStubModel } from './stub-steer-model.mjs';

const IS_WIN = process.platform === 'win32';
const PROBE = 'probe-edit.txt';
const REPLY = 'NO_STEER';
// Сервер из другого каталога (теневая копия), когда рабочее дерево не поднимается.
const serverAt = process.argv.indexOf('--server-dir');
const SERVER_DIR = serverAt > 0 ? process.argv[serverAt + 1] : undefined;

function findCli() {
  const names = IS_WIN ? ['opencode.cmd', 'opencode.exe', 'opencode'] : ['opencode'];
  const dirs = [
    ...(process.env.STEER_CLI_DIR ? process.env.STEER_CLI_DIR.split(delimiter) : []),
    ...(process.env.PATH ?? process.env.Path ?? '').split(delimiter),
  ];
  return dirs.find((dir) => dir && names.some((file) => existsSync(join(dir, file))));
}

/** Сам исполняемый файл: обёртка зовёт его напрямую, без оболочки. */
function realBinary(dir) {
  const candidates = IS_WIN
    ? [
        join(dir, 'opencode.exe'),
        // node_modules/.bin — обёртка рядом с пакетом.
        join(dir, '..', 'opencode-ai', 'bin', 'opencode.exe'),
        // Глобальная установка npm (`npm i -g opencode-ai`): обёртка в каталоге npm.
        join(dir, 'node_modules', 'opencode-ai', 'bin', 'opencode.exe'),
      ]
    : [join(dir, 'opencode')];
  return candidates.find((file) => existsSync(file));
}

/**
 * PID процессов, в командной строке которых есть один из каталогов. Стенд снимает
 * панель жёстко, и `opencode serve` её переживает. Снимаем ровно то, чего до
 * прогона не было.
 */
function processesUnder(dirs) {
  const norm = (text) => text.toLowerCase().replace(/[\\/]+/g, '/');
  const long = (dir) => {
    try {
      return realpathSync.native(dir);
    } catch {
      return dir;
    }
  };
  const needles = dirs
    .flatMap((dir) => [dir, long(dir)])
    .map((dir) => norm(dir).replace(/\/+$/, ''));
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
        .filter((match) => match && needles.some((needle) => norm(match[2]).includes(needle)))
        .map((match) => Number(match[1])),
    );
  } catch {
    return new Set();
  }
}

function reap(before, dirs) {
  for (const pid of processesUnder(dirs)) {
    if (before.has(pid) || pid === process.pid) continue;
    try {
      process.kill(pid);
    } catch {
      // уже вышел
    }
  }
}

async function until(probe, seconds) {
  for (let i = 0; i < seconds * 4; i += 1) {
    const value = await probe();
    if (value) return value;
    await wait(250);
  }
  return undefined;
}

const { check, finish } = reporter();
const cliDir = findCli();
if (!cliDir) {
  console.log('Не проверено: opencode нет ни в STEER_CLI_DIR, ни в PATH.');
  process.exit(2);
}
const binary = realBinary(cliDir);
if (!binary) {
  console.log(`Не проверено: в ${cliDir} не найден исполняемый файл opencode.`);
  process.exit(2);
}
console.log(
  `opencode: ${binary} (${execFileSync(binary, ['--version'], { encoding: 'utf8' }).trim()})`,
);

const realBefore = snapshotRealProviderDirs();
const stub = await startStubModel({
  marker: 'never-steered',
  holdMs: 200,
  toolLine: `echo edited > ${PROBE}`,
});
const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'cc-cli-opencode-')));
const before = processesUnder([cliDir, root]);

// Конфигурация OpenCode — только модель-заглушка, прав в ней НЕТ: умолчание самого
// OpenCode («можно всё») и есть то, против чего держится переключатель.
const configFile = join(root, 'opencode.json');
writeFileSync(
  configFile,
  JSON.stringify({
    $schema: 'https://opencode.ai/config.json',
    provider: {
      stub: {
        npm: '@ai-sdk/openai-compatible',
        name: 'stub',
        options: { baseURL: `http://127.0.0.1:${stub.port}/v1`, apiKey: 'x' },
        models: { 'stub-model': { name: 'stub', tool_call: true } },
      },
    },
    model: 'stub/stub-model',
  }),
);
const xdg = (name) => {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  return dir;
};
const cliEnv = {
  OPENCODE_CONFIG: configFile,
  XDG_CONFIG_HOME: xdg('xdg-config'),
  XDG_DATA_HOME: xdg('xdg-data'),
  XDG_STATE_HOME: xdg('xdg-state'),
  XDG_CACHE_HOME: xdg('xdg-cache'),
};

/** Каталог разговора; `permission` — проектный opencode.json с правилами человека. */
const project = (name, permission) => {
  const dir = join(root, 'projects', name);
  mkdirSync(dir, { recursive: true });
  if (permission) writeFileSync(join(dir, 'opencode.json'), JSON.stringify({ permission }));
  return dir;
};

/** Один вопрос в разговор с каталогом `dir`; `onAsk` решает карточки. */
async function converse(stand, dir, { allowEdits = false, onAsk, seconds = 120 } = {}) {
  const created = await stand.api('/provider-chat/chats', {
    method: 'POST',
    body: { workdir: dir },
  });
  if (created.status !== 200) throw new Error(`разговор не создан: ${created.text}`);
  const id = created.body.id;
  if (allowEdits) {
    const patched = await stand.api(`/provider-chat/chats/${id}`, {
      method: 'PATCH',
      body: { allowEdits: true },
    });
    if (patched.status !== 200) throw new Error(`переключатель не записан: ${patched.text}`);
  }
  const requestsBefore = stub.requests.length;
  const sent = await stand.api(`/provider-chat/chats/${id}/send`, {
    method: 'POST',
    body: { text: 'Запиши файл, пожалуйста.' },
  });
  if (sent.status !== 200) throw new Error(`вопрос не принят: ${sent.text}`);
  const asks = [];
  const started = Date.now();
  const ended = await until(async () => {
    const status = (await stand.api(`/provider-chat/chats/${id}/status`)).body;
    for (const ask of status?.permissions ?? []) {
      if (asks.some((item) => item.id === ask.id)) continue;
      asks.push(ask);
      const fileBefore = existsSync(join(dir, PROBE));
      ask.fileBeforeDecision = fileBefore;
      const decision = onAsk ? onAsk(ask) : 'deny';
      await stand.api(`/provider-chat/chats/${id}/permissions/${ask.id}`, {
        method: 'POST',
        body: { decision },
      });
    }
    return status?.isRunning === false;
  }, seconds);
  if (!ended) {
    await stand.api(`/provider-chat/chats/${id}/stop`, { method: 'POST', body: {} });
  }
  const chat = (await stand.api(`/provider-chat/chats/${id}`)).body;
  return {
    ended: Boolean(ended),
    seconds: Math.round((Date.now() - started) / 1000),
    asks,
    last: chat?.messages?.at(-1),
    written: existsSync(join(dir, PROBE)),
    modelRequests: stub.requests.length - requestsBefore,
  };
}

const short = (value) => JSON.stringify(value)?.slice(0, 400);

let stand;
try {
  check(
    'файл конфигурации OpenCode на месте (иначе CLI молча идёт в своё облако)',
    existsSync(configFile),
  );

  // --- Сессия `opencode serve` -------------------------------------------------
  console.log('\nСессия opencode serve');
  stand = await startStand({
    web: false,
    noClaude: true,
    ...(SERVER_DIR ? { serverDir: SERVER_DIR } : {}),
    label: 'cli-opencode',
    settings: { provider: 'opencode' },
    extraPath: [cliDir],
    env: cliEnv,
  });

  const a = await converse(stand, project('a'), { onAsk: () => 'deny' });
  check('A: ход кончился', a.ended, short(a));
  check('A: модель-заглушка получила запросы этого хода', a.modelRequests > 0, short(a));
  check(
    'A: правки выключены → карточка разрешения (bash)',
    a.asks.length === 1 && a.asks[0].tool === 'bash',
    short(a.asks),
  );
  check('A: до решения файла нет', a.asks[0]?.fileBeforeDecision === false, short(a.asks));
  check('A: «Запретить» → файла нет', !a.written);
  check(
    `A: ответ — текст модели (${REPLY}), транспорт session`,
    a.last?.role === 'assistant' && a.last.content === REPLY && a.last.transport === 'session',
    short(a.last),
  );

  const b = await converse(stand, project('b'), { onAsk: () => 'allow' });
  check('B: правки выключены → карточка', b.asks.length === 1, short(b.asks));
  check('B: «Разрешить» → файл записан', b.written, short(b));
  check(
    'B: ответ — текст модели',
    b.last?.content === REPLY && b.last?.transport === 'session',
    short(b.last),
  );

  const c = await converse(stand, project('c'), { allowEdits: true, onAsk: () => 'deny' });
  check('C: правки включены → карточки нет', c.asks.length === 0, short(c.asks));
  check('C: правки включены → файл записан', c.written, short(c));
  check(
    'C: ответ — текст модели',
    c.last?.content === REPLY && c.last?.transport === 'session',
    short(c.last),
  );

  const d = await converse(stand, project('d', { bash: 'deny' }), {
    allowEdits: true,
    onAsk: () => 'allow',
  });
  check(
    'D: явный запрет человека, правки включены → карточки нет',
    d.asks.length === 0,
    short(d.asks),
  );
  check('D: явный запрет человека не ослаблен → файла нет', !d.written, short(d));
  check('D: ход кончился ответом', d.ended && d.last?.role === 'assistant', short(d.last));

  const e = await converse(stand, project('e', { bash: 'allow' }), { onAsk: () => 'deny' });
  check('E: явное «allow» человека → карточки нет', e.asks.length === 0, short(e.asks));
  check('E: явное «allow» человека → файл записан', e.written, short(e));

  await stand.stop();
  stand = undefined;
  reap(before, [cliDir, root]);

  // --- Одиночный запуск `opencode run` ----------------------------------------
  // Обёртка под именем CLI: `serve` отказывает (панель уходит в one-shot), всё
  // прочее — настоящий opencode с тем же argv и УНАСЛЕДОВАННЫМ stdin: открытый
  // панелью ввод держал бы `run` вечно — это и проверяется.
  console.log('\nОдиночный запуск opencode run');
  const wrapDir = join(root, 'oneshot-bin');
  mkdirSync(wrapDir, { recursive: true });
  const argvLog = join(root, 'oneshot-argv.jsonl');
  writeFileSync(
    join(wrapDir, 'wrap.mjs'),
    `import { spawn } from 'node:child_process';
import { appendFileSync } from 'node:fs';
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(argvLog)}, JSON.stringify({ args, cwd: process.cwd() }) + '\\n');
if (args[0] === 'serve') process.exit(1);
const child = spawn(${JSON.stringify(binary)}, args, { stdio: 'inherit', windowsHide: true });
child.on('exit', (code) => process.exit(code ?? 1));
`,
  );
  if (IS_WIN) {
    // Форма npm cmd-shim — та, что панель разбирает без cmd.exe (`lib/win-shim.ts`).
    writeFileSync(
      join(wrapDir, 'opencode.cmd'),
      [
        '@ECHO off',
        'GOTO start',
        ':find_dp0',
        'SET dp0=%~dp0',
        'EXIT /b',
        ':start',
        'SETLOCAL',
        'CALL :find_dp0',
        '',
        'IF EXIST "%dp0%\\node.exe" (',
        '  SET "_prog=%dp0%\\node.exe"',
        ') ELSE (',
        '  SET "_prog=node"',
        '  SET PATHEXT=%PATHEXT:;.JS;=;%',
        ')',
        '',
        'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\wrap.mjs" %*',
        '',
      ].join('\r\n'),
    );
  } else {
    writeFileSync(
      join(wrapDir, 'opencode'),
      `#!/bin/sh\nexec "${process.execPath}" "${join(wrapDir, 'wrap.mjs')}" "$@"\n`,
      { mode: 0o755 },
    );
  }
  const runArgv = () =>
    existsSync(argvLog)
      ? readFileSync(argvLog, 'utf8')
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line))
          .filter((entry) => entry.args[0] === 'run')
      : [];

  stand = await startStand({
    web: false,
    noClaude: true,
    ...(SERVER_DIR ? { serverDir: SERVER_DIR } : {}),
    label: 'cli-opencode-run',
    settings: { provider: 'opencode' },
    extraPath: [wrapDir],
    env: cliEnv,
  });

  const f = await converse(stand, project('f', { bash: 'ask' }), { seconds: 90 });
  const fRun = runArgv().at(-1);
  const fArgs = fRun?.args;
  check('F: дошло до `opencode run`', Array.isArray(fArgs), short(runArgv()));
  check('F: run запущен в каталоге разговора', fRun?.cwd === project('f'), short(fRun));
  check(
    'F: правки выключены → без --auto',
    Array.isArray(fArgs) && !fArgs.includes('--auto'),
    short(fArgs),
  );
  check(`F: ход кончился сам, не по таймауту (${f.seconds} с)`, f.ended, short(f));
  check('F: просьба отклонена самим run → файла нет', !f.written, short(f));

  const g = await converse(stand, project('g', { bash: 'ask' }), { allowEdits: true, seconds: 90 });
  const gRun = runArgv().at(-1);
  const gArgs = gRun?.args;
  check('G: run запущен в каталоге разговора', gRun?.cwd === project('g'), short(gRun));
  check(
    'G: правки включены → --auto',
    Array.isArray(gArgs) && gArgs.includes('--auto'),
    short(gArgs),
  );
  check(`G: ход кончился сам (${g.seconds} с)`, g.ended, short(g));
  check('G: файл записан', g.written, short(g));
  check(
    'F/G: в каталоге проверки файла нет (правка не ушла мимо разговора)',
    !existsSync(join(process.cwd(), PROBE)),
    process.cwd(),
  );
  check(
    `G: ответ ровно «${REPLY}», транспорт stream (служебных строк нет)`,
    g.last?.role === 'assistant' && g.last.content === REPLY && g.last.transport === 'stream',
    short(g.last),
  );
  check(
    'G: промпт — последний отдельный элемент argv',
    gArgs?.at(-1)?.includes('Запиши файл'),
    short(gArgs),
  );

  await stand.stop();
  stand = undefined;
  reap(before, [cliDir, root]);

  // --- Ключ без CLI ------------------------------------------------------------
  console.log('\nБез CLI в PATH, ключ сохранён');
  const trapHits = [];
  const trap = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      trapHits.push({ method: req.method, path: req.url, headers: req.headers, body: raw });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: 'TRAP_REPLY' } }] }));
    });
  });
  await new Promise((done) => trap.listen(0, '127.0.0.1', done));
  const SENTINEL = 'qa-opencode-key-9Xw3';
  try {
    stand = await startStand({
      web: false,
      noClaude: true,
      ...(SERVER_DIR ? { serverDir: SERVER_DIR } : {}),
      label: 'cli-opencode-key',
      settings: { provider: 'opencode' },
      env: {
        OPENAI_BASE_URL: `http://127.0.0.1:${trap.address().port}/v1`,
        OPENAI_API_KEY: SENTINEL,
      },
    });
    const saved = await stand.api('/provider-keys/opencode', {
      method: 'PUT',
      body: { key: SENTINEL },
    });
    check('H: ключ сохранён в панели', saved.status === 200, saved.text.slice(0, 300));
    const runner = (await stand.api('/provider-runner')).body;
    check('H: CLI в PATH не найден', runner?.cliFound === false, short(runner));
    const h = await converse(stand, project('h'), { seconds: 30 });
    check(
      'H: ответ — отказ assistant-api-base-unknown',
      h.last?.failed === true &&
        String(h.last?.content).startsWith(
          `Адрес модельного API ${runner?.providerName ?? 'OpenCode'} панели не известен`,
        ),
      short(h.last),
    );
    check(
      'H: ловушка OPENAI_BASE_URL не получила ни одного запроса',
      trapHits.length === 0,
      short(trapHits),
    );
  } finally {
    await new Promise((done) => trap.close(done));
  }
} catch (error) {
  if (error instanceof NotChecked) {
    console.log(`Не проверено: ${error.message}`);
    process.exitCode = 2;
  } else check('сценарий дошёл до конца', false, error?.stack ?? String(error));
} finally {
  if (stand) await stand.stop();
  reap(before, [cliDir, root]);
  await stub.close();
  await wait(500);
  const touched = diffRealProviderDirs(realBefore, snapshotRealProviderDirs());
  check('настоящие каталоги провайдеров человека не тронуты', touched.length === 0, short(touched));
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
}
if (process.exitCode === 2) process.exit(2);
finish();
