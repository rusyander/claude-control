'use strict';
/* global require, module, process, Buffer, URL, __filename */
/* eslint-disable @typescript-eslint/no-require-imports */
/**
 * Лежит в `platform/`, а не в отдельной папке захвата (план G22): прокладка — внешняя программа
 * с файловым и процессным вводом-выводом, а его правило зависимостей (`core-io-only-in-platform`)
 * пускает только сюда.
 *
 * Прокладка захвата проверок (03 §Process capture, 04 §Shape, G22). Один файл без зависимостей
 * на три роли, потому что исполняется ВНЕ ядра — в чужих процессах node и в обёртках PATH:
 *
 * 1. `NODE_OPTIONS=--require "<этот файл>"` (дорога `node-preload`): процесс node, чей главный
 *    скрипт — бегун проверки (vitest, jest, tsc, eslint, prettier, playwright), до запуска
 *    спрашивает ядро и делает ответ: повтор записанного вывода с тем же кодом | прогон под арендой
 *    (вывод копируется, итог несётся ядру при выходе) | сужение argv | отказ. Остальные процессы —
 *    нетронуты: вопрос стоит запуска node, а не каждого `node -e`.
 * 2. `node <этот файл> --agentdeck-capture-wrap <b64> …` (дорога `path-wrapper`): обёртка PATH
 *    сессии над go/pytest/cargo/dotnet/gradle/mvn — тот же вопрос, настоящий инструмент ребёнком.
 * 3. `node <этот файл> --agentdeck-capture-client` — синхронный клиент для роли 1: прокладка
 *    внутри `--require` не может ждать обещание до запуска главного скрипта, поэтому спрашивает
 *    через `spawnSync` себя же (G22).
 *
 * Ядро недоступно или ответ не читается — сомнение → прогон (F25): настоящая команда идёт как
 * есть, итог ложится в `<дом ядра>/spool/` и ядро забирает его как `unattended` (только обратная
 * связь, никогда не повтор и не состав). Дети прогона под арендой несут `AGENTDECK_CHECK_LEASE` и
 * не захватываются снова; дети любого спросившего — `AGENTDECK_CAPTURE_ASKED` (рабочие процессы
 * vitest не спрашивают за родителя).
 */

const childProcess = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');

const VARS = {
  lease: 'AGENTDECK_CHECK_LEASE',
  asked: 'AGENTDECK_CAPTURE_ASKED',
  url: 'AGENTDECK_CORE_URL',
  access: 'AGENTDECK_SESSION_TOKEN',
  procs: 'AGENTDECK_CORE_PROCS',
  home: 'AGENTDECK_CAPTURE_HOME',
  envNames: 'AGENTDECK_CAPTURE_ENV',
  waitMs: 'AGENTDECK_CAPTURE_WAIT_MS',
};

const CLIENT_FLAG = '--agentdeck-capture-client';
const WRAP_FLAG = '--agentdeck-capture-wrap';
const CAPTURE_PATH = '/v1/session/capture';
const RESULT_PATH = '/v1/session/capture/result';
/** Файл доступа захвата в доме ядра (G5): открывает только ручку захвата. */
const ACCESS_FILE = 'capture-token';
const SPOOL_DIR = 'spool';
/** Больше файлов в очереди — ядро давно не забирает: новый не пишется, причина в stderr. */
const SPOOL_CAP = 500;
/** Голова + хвост лога (04:66, `CaptureResult.log`): 2 МБ на прогон. */
const LOG_HALF = 1024 * 1024;
/**
 * Срок вопроса: ядро держит ответ, пока ждёт чужой прогон того же ключа (единственный полёт,
 * D§3.8) — до max(2× выученного, 10 мин). Дольше — ядро считается недоступным (сомнение → прогон).
 */
const ASK_WAIT_MS = 15 * 60_000;
const RESULT_WAIT_MS = 30_000;

/** Переменные, чьё значение меняет исход проверки (в ключ идёт только хеш, значения не уходят). */
const ENV_NAMES = ['NODE_ENV', 'CI', 'TZ'];

/** Главные скрипты бегунов проверок: путь внутри пакета, а не имя — `node_modules/.bin` ведёт сюда. */
const RUNNERS = [
  /\/node_modules\/vitest\/vitest\.mjs$/,
  /\/node_modules\/(jest|jest-cli)\/bin\/jest\.js$/,
  /\/node_modules\/typescript\/(bin\/tsc|lib\/tsc\.js)$/,
  /\/node_modules\/eslint\/bin\/eslint\.js$/,
  /\/node_modules\/prettier\/(bin\/prettier\.cjs|bin-prettier\.js)$/,
  /\/node_modules\/(@playwright\/test|playwright)\/cli\.js$/,
];

function isCheckRunner(script) {
  if (typeof script !== 'string' || script === '') return false;
  const norm = script.replace(/\\/g, '/');
  return RUNNERS.some((re) => re.test(norm));
}

function envNames(extra) {
  return [
    ...new Set([
      ...ENV_NAMES,
      ...String(extra || '')
        .split(',')
        .filter(Boolean),
    ]),
  ].sort();
}

function envDigest(env, extra) {
  const rows = envNames(extra).map((name) => [name, env[name] === undefined ? null : env[name]]);
  return crypto.createHash('sha256').update(JSON.stringify(rows)).digest('hex');
}

/**
 * Значения тех же имён (`null` — не задана): ключ прогона под арендой ядро считает от окружения
 * вызывающего, а не от своего пина. В очередь `spool/` значения не пишутся — только хеш.
 */
function envValues(env, extra) {
  const out = {};
  for (const name of envNames(extra)) out[name] = env[name] === undefined ? null : env[name];
  return out;
}

/** Голова и хвост вывода: середина длинного лога выпадает, а начало и итог бегуна остаются. */
function logCap(half) {
  const limit = half || LOG_HALF;
  let head = Buffer.alloc(0);
  const tail = [];
  let tailBytes = 0;
  let dropped = 0;
  return {
    push(chunk) {
      let buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8');
      if (head.length < limit) {
        const take = Math.min(limit - head.length, buf.length);
        head = Buffer.concat([head, buf.subarray(0, take)]);
        buf = buf.subarray(take);
      }
      if (buf.length === 0) return;
      tail.push(buf);
      tailBytes += buf.length;
      while (tailBytes > limit && tail.length > 0) {
        const over = tailBytes - limit;
        const first = tail[0];
        if (first.length <= over) {
          tail.shift();
          tailBytes -= first.length;
          dropped += first.length;
        } else {
          tail[0] = first.subarray(over);
          tailBytes -= over;
          dropped += over;
        }
      }
    },
    text() {
      const mark = dropped > 0 ? `\n[agentdeck: ${dropped} bytes cut]\n` : '';
      return head.toString('utf8') + mark + Buffer.concat(tail).toString('utf8');
    },
    truncated: () => dropped > 0,
  };
}

/** Куда спрашивать: сессия ядра (адрес + токен сессии) или установленный захват (дом ядра). */
function connection(env, readFile) {
  const read = readFile || ((p) => fs.readFileSync(p, 'utf8'));
  if (env[VARS.url] && env[VARS.access]) {
    const home = env[VARS.procs] ? path.dirname(env[VARS.procs]) : undefined;
    return { url: env[VARS.url], bearer: env[VARS.access], tokenKind: 'session', home };
  }
  const home = env[VARS.home];
  if (!home) return undefined;
  let bearer;
  try {
    bearer = read(path.join(home, ACCESS_FILE)).trim();
  } catch {
    return { unreachable: 'capture access file unread', home, tokenKind: 'capture' };
  }
  let url;
  try {
    const doc = JSON.parse(read(path.join(home, 'procs.json')));
    const cores = Array.isArray(doc && doc.cores) ? doc.cores : [];
    const newest = [...cores].sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0))[0];
    // Только loopback, и порт — из той же проверенной строки адреса (B2-F03): поле `port`, с ней
    // разошедшееся, доступ захвата не получает.
    const matched = newest && /^http:\/\/127\.0\.0\.1:(\d{1,5})\/?$/.exec(String(newest.url));
    const port = matched ? Number(matched[1]) : 0;
    if (port > 0 && port < 65536) url = `http://127.0.0.1:${port}`;
  } catch {
    url = undefined;
  }
  if (!url || !bearer) return { unreachable: 'no core in procs.json', home, tokenKind: 'capture' };
  return { url, bearer, tokenKind: 'capture', home };
}

/** Один запрос JSON к ядру; исход — ответ или «недоступно» с причиной, исключений нет. */
function postJson(call) {
  return new Promise((resolve) => {
    let target;
    try {
      target = new URL(call.path, call.url);
    } catch (error) {
      resolve({ kind: 'unreachable', reason: `bad url: ${error.message}` });
      return;
    }
    const body = Buffer.from(JSON.stringify(call.body), 'utf8');
    const req = http.request(
      target,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': body.length,
          authorization: `Bearer ${call.bearer}`,
        },
        timeout: call.timeoutMs,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let parsed;
          try {
            parsed = JSON.parse(text);
          } catch {
            parsed = null;
          }
          resolve({ kind: 'reply', status: res.statusCode || 0, body: parsed });
        });
      },
    );
    req.on('timeout', () => req.destroy(new Error(`timeout after ${call.timeoutMs} ms`)));
    req.on('error', (error) => resolve({ kind: 'unreachable', reason: error.message }));
    req.end(body);
  });
}

function waitOf(env, fallback) {
  const asked = Number(env[VARS.waitMs]);
  return Number.isFinite(asked) && asked > 0 ? Math.min(asked, fallback) : fallback;
}

/** Синхронный вопрос (роль 1): ребёнок node с этим же файлом, без NODE_OPTIONS — без рекурсии. */
function askSync(call) {
  const env = { ...process.env };
  delete env.NODE_OPTIONS;
  const run = childProcess.spawnSync(process.execPath, [__filename, CLIENT_FLAG], {
    input: JSON.stringify(call),
    env,
    encoding: 'utf8',
    windowsHide: true,
    timeout: call.timeoutMs + 5_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (run.error) return { kind: 'unreachable', reason: run.error.message };
  try {
    return JSON.parse(run.stdout);
  } catch {
    return { kind: 'unreachable', reason: `client printed no answer (exit ${run.status})` };
  }
}

/** Ответ ядра годится, только если это 200 с известным видом; иначе — сомнение → прогон. */
function answerOf(outcome) {
  if (!outcome || outcome.kind !== 'reply') {
    return { doubt: outcome ? outcome.reason : 'no outcome' };
  }
  const kinds = ['pass-through', 'replay', 'run', 'narrow', 'refuse'];
  const body = outcome.body;
  if (outcome.status !== 200 || !body || !kinds.includes(body.kind)) {
    const code = body && body.code ? ` ${body.code}` : '';
    return { doubt: `core answered ${outcome.status}${code}` };
  }
  // Повтор без целого кода выхода или пути лога — не ответ (B2-F04): иначе `process.exit(undefined)`
  // выходит нулём, и красная запись читалась бы зелёной.
  if (
    body.kind === 'replay' &&
    (!Number.isInteger(body.exit) || typeof body.logPath !== 'string')
  ) {
    return { doubt: 'core answered replay without an integer exit or a log path' };
  }
  return { answer: body };
}

function resultTaken(outcome) {
  return Boolean(outcome && outcome.kind === 'reply' && outcome.status === 200);
}

/** Записанный вывод для повтора: `.gz` хранилища или простой текст. */
function readLog(file) {
  const bytes = fs.readFileSync(file);
  return file.endsWith('.gz') ? zlib.gunzipSync(bytes) : bytes;
}

// ── личность дерева для очереди (B2-F01) ──────────────────────────────────────────────────────

/** Переменные, которыми git уводит команду в чужой репозиторий или индекс (как `platform/git/run.ts`). */
const GIT_ENV_DROP = new Set([
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_COMMON_DIR',
  'GIT_PREFIX',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_NAMESPACE',
]);
const TREE_WAIT_MS = 60_000;
const OID = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
const FLAG_CHUNK = 100;

/** Один вызов git; ненулевой код — исключение, кроме названных `ok`. */
function gitSync(dir, args, extraEnv, ok) {
  const env = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (!GIT_ENV_DROP.has(name.toUpperCase())) env[name] = value;
  }
  env.GIT_OPTIONAL_LOCKS = '0';
  env.GIT_TERMINAL_PROMPT = '0';
  Object.assign(env, extraEnv || {});
  const base = ['-c', 'core.quotepath=off'];
  if (process.platform === 'win32') base.push('-c', 'core.longpaths=true');
  const run = childProcess.spawnSync('git', [...base, '-C', dir, ...args], {
    env,
    encoding: 'utf8',
    windowsHide: true,
    timeout: TREE_WAIT_MS,
    maxBuffer: 256 * 1024 * 1024,
  });
  if (run.error) throw run.error;
  if (run.status !== 0 && !(ok || []).includes(run.status)) {
    throw new Error(`git ${args[0]}: exit ${run.status}`);
  }
  return { code: run.status, stdout: run.stdout };
}

/** Флаги, что прячут правку от `add -A`, — снимаются во временном индексе, как у ядра (B1-F04). */
function clearHidingFlags(top, env) {
  const out = gitSync(top, ['ls-files', '-v', '-z'], env).stdout;
  const assumed = [];
  const skipped = [];
  for (const rec of out.split('\0')) {
    if (rec.length < 3 || rec[1] !== ' ') continue;
    const tag = rec[0];
    const file = rec.slice(2);
    if (tag !== tag.toUpperCase()) assumed.push(file);
    if (tag.toUpperCase() === 'S' && fs.existsSync(path.join(top, file))) skipped.push(file);
  }
  for (const [flag, files] of [
    ['--no-assume-unchanged', assumed],
    ['--no-skip-worktree', skipped],
  ]) {
    for (let i = 0; i < files.length; i += FLAG_CHUNK) {
      gitSync(top, ['update-index', flag, '--', ...files.slice(i, i + FLAG_CHUNK)], env);
    }
  }
}

function buildTree(top, indexFile, seedFrom) {
  const env = { GIT_INDEX_FILE: indexFile };
  if (seedFrom !== null && fs.existsSync(seedFrom)) {
    fs.copyFileSync(seedFrom, indexFile);
    clearHidingFlags(top, env);
  } else {
    const head = gitSync(top, ['rev-parse', '--verify', '--quiet', 'HEAD^{tree}'], {}, [1]);
    if (head.code === 0) gitSync(top, ['read-tree', 'HEAD'], env);
  }
  gitSync(
    top,
    ['-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false', 'add', '-A', '--', '.'],
    env,
  );
  const id = gitSync(top, ['write-tree'], env).stdout.trim();
  if (!OID.test(id)) throw new Error('write-tree printed no tree id');
  return id;
}

/**
 * Id дерева рабочей копии папки прогона — тем же способом, что `platform/git/tree.ts`
 * (`scratchIndexTree`, временный индекс, настоящий не трогается); тест сверяет оба. Ядро
 * забирает очередь позже, и ключ оно считает по дереву В МИГ ЗАБОРА: без этой личности прогон
 * красного X лёг бы записью на исправленное Y. `null` — дерево не прочитано (не репозиторий, нет
 * git): такой файл ядро не примет, а не примет за чужое содержимое.
 */
function worktreeTree(cwd) {
  let dir;
  try {
    const top = gitSync(cwd, ['rev-parse', '--show-toplevel']).stdout.trim();
    const index = gitSync(top, [
      'rev-parse',
      '--path-format=absolute',
      '--git-path',
      'index',
    ]).stdout.trim();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdeck-index-'));
    try {
      return buildTree(top, path.join(dir, 'copy'), index);
    } catch {
      return buildTree(top, path.join(dir, 'fresh'), null);
    }
  } catch {
    return null;
  } finally {
    if (dir) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // Временный индекс не снялся — мусор temp, не повод терять итог прогона.
      }
    }
  }
}

let spoolSeq = 0;

/** Итог прогона без ядра — в `spool/` атомарно (временный файл + переименование). */
function spool(home, record, stderr) {
  if (!home) {
    stderr('agentdeck capture: core unreachable and no core home known; run not spooled\n');
    return undefined;
  }
  const dir = path.join(home, SPOOL_DIR);
  try {
    fs.mkdirSync(dir, { recursive: true });
    const count = fs.readdirSync(dir).filter((n) => n.endsWith('.json')).length;
    if (count >= SPOOL_CAP) {
      stderr(`agentdeck capture: spool full (${count} files); run not spooled\n`);
      return undefined;
    }
    spoolSeq += 1;
    const spoolId = `${record.pidStart}-${record.pid}-${spoolSeq}`;
    const doc = {
      v: 1,
      spoolId,
      at: Date.now(),
      road: record.road,
      argv: record.argv,
      cwd: record.cwd,
      tree: worktreeTree(record.cwd),
      envDigest: record.envDigest,
      // Имена, чьи значения вошли в хеш: ядро сверяет его со своим пином (значения не пишутся).
      envNames: Object.keys(record.env || {}).sort(),
      exit: record.exit,
      ms: record.ms,
      log: record.log,
      truncated: record.truncated === true,
      token: record.tokenKind,
    };
    const file = path.join(dir, `${spoolId}.json`);
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(doc));
    fs.renameSync(tmp, file);
    return file;
  } catch (error) {
    stderr(`agentdeck capture: spool write failed: ${error.message}\n`);
    return undefined;
  }
}

/**
 * Проверка, которую ядро пропустило насквозь с причиной (`outside`: папка вне репозиториев задачи,
 * реестр не прочитан, тот же ключ ещё идёт), — одна строка stderr (A2-F03): непойманная дорога
 * названа, а не нема. Без причины (не проверка) — пусто.
 */
function outsideText(answer) {
  const why = typeof answer.outside === 'string' ? answer.outside.trim() : '';
  return why ? `agentdeck: not captured — ${why.replace(/\s+/g, ' ')}\n` : '';
}

function refuseText(answer) {
  const unmet = Array.isArray(answer.unmet) ? answer.unmet : [];
  const lines = unmet.map((u) => `  - ${u.code} ${u.subject}: ${u.next}`);
  return `agentdeck: check refused\n${lines.join('\n')}\nnext: ${answer.next}\n`;
}

/** Старт процесса в мс эпохи (приближённо): точное время старта ОС ядро читает само по pid. */
function processStartMs() {
  return Math.round(Date.now() - process.uptime() * 1000);
}

// ── роль 1: --require ─────────────────────────────────────────────────────────────────────────

function preload() {
  const env = process.env;
  if (env[VARS.lease] || env[VARS.asked]) return;
  if (!isCheckRunner(process.argv[1])) return;
  const conn = connection(env);
  if (!conn) return;
  // Дети этого процесса (рабочие vitest) не спрашивают за него снова.
  env[VARS.asked] = '1';
  const started = Date.now();
  const request = {
    road: 'node-preload',
    argv: [process.execPath, ...process.argv.slice(1)],
    cwd: process.cwd(),
    envDigest: envDigest(env, env[VARS.envNames]),
    env: envValues(env, env[VARS.envNames]),
    pid: process.pid,
    pidStart: processStartMs(),
  };
  const stderr = (line) => process.stderr.write(line);
  const outcome = conn.unreachable
    ? { kind: 'unreachable', reason: conn.unreachable }
    : askSync({
        url: conn.url,
        bearer: conn.bearer,
        path: CAPTURE_PATH,
        body: request,
        timeoutMs: waitOf(env, ASK_WAIT_MS),
      });
  const judged = answerOf(outcome);
  if (judged.doubt) {
    teeAtExit({ conn, request, started, lease: undefined, stderr });
    return;
  }
  const answer = judged.answer;
  if (answer.kind === 'pass-through') {
    stderr(outsideText(answer));
    return;
  }
  if (answer.kind === 'refuse') {
    stderr(refuseText(answer));
    process.exit(Number.isInteger(answer.exit) ? answer.exit : 1);
  }
  if (answer.kind === 'replay') {
    let log;
    try {
      log = readLog(answer.logPath);
    } catch (error) {
      // Запись есть, а лога не прочитать — сомнение → прогон, а не немой код выхода.
      stderr(`agentdeck: replay log unread (${error.message}); running\n`);
      teeAtExit({ conn, request, started, lease: undefined, stderr });
      return;
    }
    stderr(`agentdeck: replayed ${answer.recordId} — ${answer.header}\n`);
    process.stdout.write(log);
    process.exit(answer.exit);
  }
  // run | narrow: прогон под арендой; сужение меняет только аргументы главного скрипта.
  if (answer.kind === 'narrow' && Array.isArray(answer.argv) && answer.argv.length >= 2) {
    process.argv.splice(2, process.argv.length - 2, ...answer.argv.slice(2));
    request.argv = [process.execPath, ...process.argv.slice(1)];
  }
  env[VARS.lease] = answer.leaseId;
  teeAtExit({
    conn,
    request,
    started,
    lease: { leaseId: answer.leaseId, checkRunId: answer.checkRunId },
    stderr,
  });
}

/** Копия stdout/stderr; на выходе — итог ядру (под арендой) или в очередь (без ядра). */
function teeAtExit(ctx) {
  const cap = logCap();
  for (const stream of [process.stdout, process.stderr]) {
    const write = stream.write.bind(stream);
    stream.write = (chunk, ...rest) => {
      try {
        cap.push(chunk);
      } catch {
        // Копия — не повод ломать вывод бегуна.
      }
      return write(chunk, ...rest);
    };
  }
  process.on('exit', (code) => {
    const ms = Date.now() - ctx.started;
    const log = cap.text();
    if (ctx.lease && !ctx.conn.unreachable) {
      const taken = resultTaken(
        askSync({
          url: ctx.conn.url,
          bearer: ctx.conn.bearer,
          path: RESULT_PATH,
          body: { ...ctx.lease, exit: code, signal: null, ms, log, truncated: cap.truncated() },
          timeoutMs: waitOf(process.env, RESULT_WAIT_MS),
        }),
      );
      if (taken) return;
    }
    spool(
      ctx.conn.home,
      {
        ...ctx.request,
        exit: code,
        ms,
        log,
        truncated: cap.truncated(),
        tokenKind: ctx.conn.tokenKind,
      },
      ctx.stderr,
    );
  });
}

// ── роль 2: обёртка PATH ──────────────────────────────────────────────────────────────────────

/**
 * Номера сигналов, которыми останавливают проверку (POSIX, одинаковы на Linux и macOS); прочий
 * сигнал — 128 + 1: код всё равно ненулевой, а прокладка не тянет знание ОС.
 */
const SIGNALS = { SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGKILL: 9, SIGTERM: 15 };

/** Код как у оболочки: сигнал — 128 + номер, не запустилось — 127. */
function exitOf(status, signal) {
  if (signal) return 128 + (SIGNALS[signal] || 1);
  return status === null || status === undefined ? 1 : status;
}

function passthrough(real, args) {
  const run = childProcess.spawnSync(real[0], [...real.slice(1), ...args], {
    stdio: 'inherit',
    windowsHide: true,
  });
  if (run.error) {
    process.stderr.write(`agentdeck capture wrapper: ${run.error.message}\n`);
    return 127;
  }
  return exitOf(run.status, run.signal);
}

/** Настоящий инструмент ребёнком: вывод идёт как есть и в копию; итог — код и лог. */
function runTee(real, args, extraEnv) {
  return new Promise((resolve) => {
    const cap = logCap();
    const started = Date.now();
    let child;
    try {
      child = childProcess.spawn(real[0], [...real.slice(1), ...args], {
        stdio: ['inherit', 'pipe', 'pipe'],
        env: { ...process.env, ...extraEnv },
        windowsHide: true,
      });
    } catch (error) {
      process.stderr.write(`agentdeck capture wrapper: ${error.message}\n`);
      resolve({ exit: 127, signal: null, ms: 0, log: '', truncated: false });
      return;
    }
    child.stdout.on('data', (c) => {
      cap.push(c);
      process.stdout.write(c);
    });
    child.stderr.on('data', (c) => {
      cap.push(c);
      process.stderr.write(c);
    });
    child.on('error', (error) => {
      process.stderr.write(`agentdeck capture wrapper: ${error.message}\n`);
      resolve({
        exit: 127,
        signal: null,
        ms: Date.now() - started,
        log: cap.text(),
        truncated: cap.truncated(),
      });
    });
    child.on('close', (status, signal) => {
      resolve({
        exit: exitOf(status, signal),
        signal: signal || null,
        ms: Date.now() - started,
        log: cap.text(),
        truncated: cap.truncated(),
      });
    });
  });
}

/** Флаги перед подкомандой, берущие следующее слово значением (`go -C sub test`). */
const VALUE_FLAGS = new Set(['-C']);
/** Инструменты целей: проверка — любая цель в строке (`mvn clean test`, `gradle clean check`). */
const GOAL_TOOLS = new Set(['mvn', 'gradle']);

/** Позиционные слова до `--`: опции (`-q`, `--offline`) и тулчейн (`+nightly`) пропущены. */
function positionalWords(args) {
  const out = [];
  for (let i = 0; i < args.length; i += 1) {
    const word = String(args[i]);
    if (word === '--') break;
    if (VALUE_FLAGS.has(word)) {
      i += 1;
      continue;
    }
    if (word.startsWith('-') || word.startsWith('+')) continue;
    out.push(word);
  }
  return out;
}

/**
 * Подкоманда, о которой спрашивать ядро (B2r2-F03): `*` — любая; у инструментов целей — любая цель
 * из списка; иначе первое позиционное слово после опций (`cargo +nightly -q test` → `test`).
 */
function asksCore(ask, args, tool) {
  if (ask === '*') return true;
  if (!Array.isArray(ask)) return false;
  const words = positionalWords(args);
  if (GOAL_TOOLS.has(tool)) return words.some((word) => ask.includes(word));
  return words.length > 0 && ask.includes(words[0]);
}

async function wrap(argv) {
  const [encoded, ...args] = argv;
  let spec;
  try {
    spec = JSON.parse(Buffer.from(String(encoded), 'base64url').toString('utf8'));
  } catch {
    spec = undefined;
  }
  if (!spec || !Array.isArray(spec.real) || typeof spec.tool !== 'string') {
    process.stderr.write('agentdeck capture wrapper: bad arguments\n');
    return 2;
  }
  const env = process.env;
  const conn =
    asksCore(spec.ask, args, spec.tool) && !env[VARS.lease] ? connection(env) : undefined;
  if (!conn) return passthrough(spec.real, args);
  const request = {
    road: 'path-wrapper',
    argv: [spec.tool, ...args],
    cwd: process.cwd(),
    envDigest: envDigest(env, env[VARS.envNames]),
    env: envValues(env, env[VARS.envNames]),
    pid: process.pid,
    pidStart: processStartMs(),
  };
  const outcome = conn.unreachable
    ? { kind: 'unreachable', reason: conn.unreachable }
    : await postJson({
        url: conn.url,
        bearer: conn.bearer,
        path: CAPTURE_PATH,
        body: request,
        timeoutMs: waitOf(env, ASK_WAIT_MS),
      });
  const judged = answerOf(outcome);
  const stderr = (line) => process.stderr.write(line);
  let answer = judged.answer;
  if (answer && answer.kind === 'pass-through') {
    stderr(outsideText(answer));
    return passthrough(spec.real, args);
  }
  if (answer && answer.kind === 'refuse') {
    stderr(refuseText(answer));
    return Number.isInteger(answer.exit) ? answer.exit : 1;
  }
  if (answer && answer.kind === 'replay') {
    try {
      const log = readLog(answer.logPath);
      stderr(`agentdeck: replayed ${answer.recordId} — ${answer.header}\n`);
      process.stdout.write(log);
      return answer.exit;
    } catch (error) {
      stderr(`agentdeck: replay log unread (${error.message}); running\n`);
      answer = undefined;
    }
  }
  if (!answer) {
    const ran = await runTee(spec.real, args, {});
    spool(conn.home, { ...request, ...ran, tokenKind: conn.tokenKind }, stderr);
    return ran.exit;
  }
  const runArgs =
    answer.kind === 'narrow' && Array.isArray(answer.argv) && answer.argv.length >= 1
      ? answer.argv.slice(1)
      : args;
  const ran = await runTee(spec.real, runArgs, { [VARS.lease]: answer.leaseId });
  const posted = await postJson({
    url: conn.url,
    bearer: conn.bearer,
    path: RESULT_PATH,
    body: {
      leaseId: answer.leaseId,
      checkRunId: answer.checkRunId,
      exit: ran.exit,
      signal: ran.signal,
      ms: ran.ms,
      log: ran.log,
      truncated: ran.truncated,
    },
    timeoutMs: waitOf(env, RESULT_WAIT_MS),
  });
  if (!resultTaken(posted)) {
    spool(
      conn.home,
      { ...request, argv: [spec.tool, ...runArgs], ...ran, tokenKind: conn.tokenKind },
      stderr,
    );
  }
  return ran.exit;
}

// ── роль 3: клиент ────────────────────────────────────────────────────────────────────────────

async function client() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  let call;
  try {
    call = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    process.stdout.write(JSON.stringify({ kind: 'unreachable', reason: 'client input unread' }));
    return;
  }
  process.stdout.write(JSON.stringify(await postJson(call)));
}

// ── вход ──────────────────────────────────────────────────────────────────────────────────────

/**
 * Этот же файл — главный скрипт процесса? Под `NODE_OPTIONS --require <этот файл>` (сессия ядра)
 * обёртка PATH запускает `node <этот файл> --agentdeck-capture-wrap …`: node сначала грузит его
 * как прокладку, а главным берёт тот же модуль ИЗ КЭША — второго исполнения нет, и
 * `require.main === module` не наступает никогда. Без этой проверки обёртка молча выходила с 0,
 * не запустив инструмент. `argv[1]` к этому моменту уже абсолютный (node разрешает его до
 * прокладок); регистр на Windows не различается.
 */
function mainIsThisFile() {
  if (require.main === module) return true;
  const main = process.argv[1];
  if (typeof main !== 'string' || main === '') return false;
  const norm = (p) => {
    const abs = path.resolve(p);
    return process.platform === 'win32' ? abs.toLowerCase() : abs;
  };
  return norm(main) === norm(__filename);
}

if (mainIsThisFile()) {
  const mode = process.argv[2];
  if (mode === CLIENT_FLAG) {
    client().then(
      () => undefined,
      () => (process.exitCode = 1),
    );
  } else if (mode === WRAP_FLAG) {
    wrap(process.argv.slice(3)).then(
      (code) => (process.exitCode = code),
      (error) => {
        process.stderr.write(`agentdeck capture wrapper: ${error.message}\n`);
        process.exitCode = 1;
      },
    );
  } else {
    process.stderr.write('agentdeck capture: unknown mode\n');
    process.exitCode = 2;
  }
} else if (module.parent && module.parent.id === 'internal/preload') {
  try {
    preload();
  } catch (error) {
    // Сбой прокладки не роняет проверку человека: команда идёт без захвата, причина названа.
    process.stderr.write(`agentdeck capture: preload failed: ${error.message}\n`);
  }
}

module.exports = {
  VARS,
  CLIENT_FLAG,
  WRAP_FLAG,
  ACCESS_FILE,
  RUNNERS,
  ENV_NAMES,
  SPOOL_CAP,
  isCheckRunner,
  envDigest,
  envValues,
  logCap,
  connection,
  answerOf,
  asksCore,
  exitOf,
  outsideText,
  refuseText,
  spool,
};
