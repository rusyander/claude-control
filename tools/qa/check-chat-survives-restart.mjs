#!/usr/bin/env node
/**
 * Живое доказательство: чат переживает перезапуск панели.
 *
 * Владелец работает в чате панели, пока агент правит саму панель: сервер
 * перезапускается от каждой правки (dev-сторож), падает, его перезапускают
 * руками. Ни одно из этого не имеет права сломать ход: убить CLI, потерять
 * кусок потока, отказать в правах «Панель перезапускалась», забыть карточку,
 * повиснуть. Юнит-тесты посредника проверяют его протокол; здесь — весь путь
 * целиком, на настоящих процессах, и доказательство — то, что видит человек.
 *
 * Подменено только то, что снаружи: CLI (фальшивый `claude` на PATH говорит
 * протоколом потокового ввода, пишет транскрипт, спрашивает права через
 * НАСТОЯЩИЙ мост `permission-prompt-server.mjs` из своего `--mcp-config` и
 * держит фоновую команду, которая пишет метку). Сервер панели — копия
 * `apps/server/src` во временной папке под НАСТОЯЩИМ dev-сторожем
 * (`src/lib/dev-watch.mjs`): «правка» и «синтаксическая ошибка» делаются в
 * копии, и рабочий стенд их не видит. Фронт — настоящий Vite, браузер —
 * Playwright. Свой каталог конфигурации, свой дом, свои порты; токенов не
 * тратится, `~/.claude` не трогается.
 *
 * Сценарии (каждый — строки таблицы):
 *   A. сервер убит жёстко, пока агент ждёт разрешения: сторож поднимает
 *      сервер, карточка снова видна и отвечается из интерфейса, агент получает
 *      ответ, поток идёт дальше без дыр и повторов, процесс CLI тот же;
 *   B. правка файла сервера посреди потока: сторож перезапускает сервер, поток
 *      в интерфейсе без дыр и повторов, CLI тот же, фоновая команда из хода A
 *      дожила и написала метку, агент сам начал ход по её концу;
 *   C. синтаксическая ошибка в файле сервера: прежний сервер продолжает
 *      отвечать, сторож говорит об ошибке; исправление — обычный перезапуск;
 *   D. (отрицательный) посредник убит снаружи: прогон не виснет, лента
 *      говорит человеческими словами, а следующее сообщение продолжает
 *      разговор новым процессом с `--resume`.
 *
 * Запуск: node tools/qa/check-chat-survives-restart.mjs
 * Переменные: RESTART_PANEL_PORT (5271), RESTART_WEB_PORT (8981),
 * RESTART_ONLY=A,B,C,D — только эти сценарии (порядок A→B→C→D сохраняется).
 * Выход 0 — всё сошлось, 1 — расхождения, 2 — не проверено (стенд не поднялся).
 */
import { execFileSync, spawn } from 'node:child_process';
import {
  appendFileSync,
  closeSync,
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  rmdirSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as wait } from 'node:timers/promises';
import { chromium } from 'playwright';
import { bypassOnboarding } from './bypass-onboarding.mjs';
import { killProcessTree } from '../../apps/server/src/lib/kill-tree.mjs';

const isWindows = process.platform === 'win32';
/** Начало прогона: процесс, запущенный раньше, нашим быть не может. */
const STARTED_AT = Date.now();
const REPO = fileURLToPath(new URL('../../', import.meta.url));
const PANEL_PORT = Number(process.env.RESTART_PANEL_PORT ?? 5271);
const WEB_PORT = Number(process.env.RESTART_WEB_PORT ?? 8981);
const PANEL = `http://127.0.0.1:${PANEL_PORT}`;
const WEB = `http://127.0.0.1:${WEB_PORT}`;
/**
 * Сценарий R — вопрос прав, сервер убит жёстко, сигнал «жду человека» × срок
 * молчания MCP-вызова. По умолчанию его ведёт ФАЛЬШИВЫЙ CLI, который обрывает
 * вызов прав так же, как настоящий: без `notifications/progress` с токеном вызова
 * дольше срока молчания — вызов считается упавшим (`FAKE_MCP_IDLE_MS`). Так R
 * идёт вместе с A–D без установленного CLI. `RESTART_REAL_CLI=1` — НАСТОЯЩИЙ
 * `claude` и стаб модели в этом процессе (`ANTHROPIC_BASE_URL`): токенов не
 * тратится, в этом режиме по умолчанию идёт только R.
 */
const REAL = process.env.RESTART_REAL_CLI === '1';
/**
 * Срок молчания MCP-вызова у CLI — ускорен, чтобы удержание его перекрывало. Меньше
 * 30 с CLI 2.1.282 не берёт (обрыв без сигнала пришёл ровно на 30 с при заданных 20);
 * фальшивому хватает восьми.
 */
const REAL_IDLE_MS = Number(process.env.RESTART_REAL_IDLE_MS ?? (REAL ? 30_000 : 8_000));
/** Сколько карточка ждёт ответа от первого показа — дольше срока молчания. */
const REAL_HOLD_MS = Number(process.env.RESTART_REAL_HOLD_MS ?? (REAL ? 45_000 : 14_000));
/** Номер настоящего CLI сценария R — для уборки: в его команде нет папки прогона. */
let realCliPid = 0;
const ONLY = new Set(
  (process.env.RESTART_ONLY ?? (REAL ? 'R' : 'A,B,C,D,R'))
    .split(',')
    .map((part) => part.trim().toUpperCase())
    .filter(Boolean),
);
/** Сколько живёт фоновая команда хода A: переживает перезапуск в сценарии B. */
const BG_MS = 15_000;

class NotChecked extends Error {}

const rows = [];
const check = (ok, text, detail = '') => {
  rows.push({ ok, text, detail });
  console.log(`${ok ? 'ок    ' : 'ПЛОХО ×'} ${text}${detail ? ` — ${detail}` : ''}`);
  return ok;
};

/* ------------------------------------------------------------------ фальшивый CLI */

/**
 * Фальшивый `claude`: протокол потокового ввода, транскрипт, права через мост
 * из `--mcp-config`, фоновая команда. Ходы идут по очереди, как у настоящего;
 * конец ввода посреди хода — доделать ход и выйти, как настоящий.
 */
const FAKE_CLI = String.raw`
import { spawn } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';

const argv = process.argv.slice(2);
if (!argv.includes('--input-format')) {
  // Проба версии и прочие разовые вызовы панели — ответить и уйти.
  process.stdout.write('2.1.999 (Claude Code)\n');
  process.exit(0);
}
const STATE = process.env.FAKE_STATE_DIR;
const BG_MS = Number(process.env.FAKE_BG_MS ?? 15000);
// Срок молчания MCP-вызова, как у настоящего CLI: без прогресса дольше — обрыв.
const IDLE_MS = Number(process.env.FAKE_MCP_IDLE_MS ?? 0);
const unq = (value) => (value === undefined ? undefined : value.replace(/^"|"$/g, ''));
const flag = (name) => {
  const at = argv.indexOf(name);
  return at >= 0 ? unq(argv[at + 1]) : undefined;
};
const session = flag('--resume') ?? flag('--session-id') ?? randomUUID();
appendFileSync(join(STATE, 'pids.txt'), process.pid + ' ' + session + ' ' + (flag('--resume') ? 'resume' : 'new') + '\n');
writeFileSync(join(STATE, 'session.txt'), session);
const cwd = process.cwd();
const dir = join(process.env.CLAUDE_CONFIG_DIR, 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'));
mkdirSync(dir, { recursive: true });
const transcript = join(dir, session + '.jsonl');
let parentUuid = null;
function record(type, message) {
  const uuid = randomUUID();
  appendFileSync(transcript, JSON.stringify({ type, message, uuid, parentUuid, sessionId: session, cwd,
    timestamp: new Date().toISOString(), isSidechain: false, userType: 'external', version: '2.1.999' }) + '\n');
  parentUuid = uuid;
}
let outOpen = true;
process.stdout.on('error', () => { outOpen = false; });
const out = (event) => { if (outOpen) process.stdout.write(JSON.stringify(event) + '\n'); };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let mcp;
let nextId = 1;
const waiting = new Map();
const progressWatch = new Map();
function rpc(method, params) {
  const id = nextId++;
  mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  return new Promise((resolve) => waiting.set(id, resolve));
}
const mcpFile = flag('--mcp-config');
if (mcpFile) {
  const guard = JSON.parse(readFileSync(mcpFile, 'utf8')).mcpServers?.['perm-guard'];
  if (guard) {
    mcp = spawn(guard.command, guard.args, { env: { ...process.env, ...guard.env }, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
    createInterface({ input: mcp.stdout }).on('line', (line) => {
      let message;
      try { message = JSON.parse(line); } catch { return; }
      if (message.method === 'notifications/progress') {
        progressWatch.get(message.params?.progressToken)?.();
        return;
      }
      const resolve = waiting.get(message.id);
      if (resolve) { waiting.delete(message.id); resolve(message); }
    });
    void rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'fake', version: '1' } });
  }
}
async function approve(tool_name, input, tool_use_id) {
  if (!mcp) return { behavior: 'deny', message: 'no broker' };
  const reply = await rpc('tools/call', { name: 'approve', arguments: { tool_name, input, tool_use_id } });
  return JSON.parse(reply.result?.content?.[0]?.text ?? '{}');
}
// Вызов прав со сроком молчания, как у настоящего CLI: каждый прогресс с
// токеном САМОГО вызова продлевает срок; тишина дольше — вызов оборван.
async function approveWatched(tool_name, input, tool_use_id) {
  if (!mcp) return { behavior: 'deny', message: 'no broker' };
  const token = 'tok-' + tool_use_id;
  return await new Promise((resolve) => {
    let timer;
    const arm = () => {
      clearTimeout(timer);
      if (IDLE_MS > 0) timer = setTimeout(() => { progressWatch.delete(token); resolve({ aborted: true }); }, IDLE_MS);
    };
    progressWatch.set(token, arm);
    arm();
    void rpc('tools/call', { name: 'approve', arguments: { tool_name, input, tool_use_id }, _meta: { progressToken: token } })
      .then((reply) => {
        clearTimeout(timer);
        progressWatch.delete(token);
        resolve(JSON.parse(reply.result?.content?.[0]?.text ?? '{}'));
      });
  });
}

let cost = 0;
const msgId = () => 'msg_' + randomUUID().replace(/-/g, '').slice(0, 20);
function init() { out({ type: 'system', subtype: 'init', session_id: session, model: 'fake-restart', tools: [], cwd }); }
function assistant(content) {
  const message = { id: msgId(), type: 'message', role: 'assistant', model: 'fake-restart', content,
    stop_reason: null, usage: { input_tokens: 1, output_tokens: 1 } };
  out({ type: 'assistant', message, session_id: session });
  record('assistant', message);
}
function result() {
  cost += 0.001;
  out({ type: 'result', subtype: 'success', is_error: false, total_cost_usd: Number(cost.toFixed(3)),
    duration_ms: 1, num_turns: 1, result: '', session_id: session, usage: { input_tokens: 1, output_tokens: 1 } });
}
async function stream(prefix, from, to, ms) {
  let text = '';
  for (let i = from; i <= to; i += 1) {
    const token = prefix + String(i).padStart(2, '0') + ' ';
    text += token;
    out({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: token } } });
    await sleep(ms);
  }
  return text.trim();
}

let bgRunning = 0;
let wakePending = false;
function startBackground() {
  bgRunning += 1;
  out({ type: 'system', subtype: 'background_tasks_changed', tasks: [{ id: 'bg-restart' }], session_id: session });
  const marker = join(STATE, 'bg-marker.txt');
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => require("fs").writeFileSync(' + JSON.stringify(marker) + ', String(process.ppid)), ' + BG_MS + ')'],
    { stdio: 'ignore', windowsHide: true });
  child.on('exit', () => {
    bgRunning -= 1;
    out({ type: 'system', subtype: 'background_tasks_changed', tasks: [], session_id: session });
    wakePending = true;
    void pump();
  });
}

const SPEC = { B: ['b', 30, 250], C: ['c', 30, 250], D: ['d', 40, 250], E: ['e', 3, 60], F: ['f', 3, 60], W: ['w', 3, 60] };
async function runTurn(content) {
  record('user', { role: 'user', content });
  init();
  const scenario = content.startsWith('WAKE') ? 'W' : (/SCENARIO:([A-Z])/.exec(content)?.[1] ?? 'E');
  if (scenario === 'R') {
    const toolUse = { type: 'tool_use', id: 'toolu_restart_r1', name: 'Bash', input: { command: 'rm -rf r-build && echo restart-ok > r-marker.txt', description: 'Clean the build, write the marker' } };
    assistant([toolUse]);
    const decision = await approveWatched('Bash', toolUse.input, toolUse.id);
    let text = String(decision.message ?? 'denied');
    let isError = true;
    if (decision.aborted) text = 'MCP tool call timed out: no progress from the permission server';
    else if (decision.behavior === 'allow') {
      rmSync(join(cwd, 'r-build'), { recursive: true, force: true });
      writeFileSync(join(cwd, 'r-marker.txt'), 'restart-ok\n');
      text = 'restart-ok';
      isError = false;
    }
    appendFileSync(join(STATE, 'r-results.jsonl'), JSON.stringify({ id: toolUse.id, error: isError, text }) + '\n');
    const toolResult = { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUse.id, content: text, is_error: isError }] };
    out({ type: 'user', message: toolResult, session_id: session });
    record('user', toolResult);
    assistant([{ type: 'text', text: 'R-FINISHED-7' }]);
    result();
    return;
  }
  if (scenario === 'A') {
    const head = await stream('a', 1, 8, 250);
    const toolUse = { type: 'tool_use', id: 'toolu_restart_a', name: 'Bash', input: { command: 'rm -rf ./scratch-a', description: 'cleanup' } };
    assistant([{ type: 'text', text: head }, toolUse]);
    writeFileSync(join(STATE, 'asked-a.txt'), String(Date.now()));
    const decision = await approve('Bash', toolUse.input, toolUse.id);
    writeFileSync(join(STATE, 'decision-a.json'), JSON.stringify(decision));
    const toolResult = { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUse.id,
      content: decision.behavior === 'allow' ? 'ok' : String(decision.message ?? 'denied'), is_error: decision.behavior !== 'allow' }] };
    out({ type: 'user', message: toolResult, session_id: session });
    record('user', toolResult);
    const tail = await stream('a', 9, 20, 150);
    startBackground();
    assistant([{ type: 'text', text: tail }]);
    result();
    return;
  }
  const [prefix, count, ms] = SPEC[scenario] ?? SPEC.E;
  const text = await stream(prefix, 1, count, ms);
  assistant([{ type: 'text', text }]);
  result();
}

const queue = [];
let busy = false;
let stdinEnded = false;
async function pump() {
  if (busy) return;
  let next;
  if (queue.length) next = queue.shift();
  else if (wakePending) {
    wakePending = false;
    out({ type: 'system', subtype: 'task_notification', status: 'completed', session_id: session });
    next = 'WAKE background finished';
  } else {
    if (stdinEnded) { mcp?.kill(); process.exit(0); }
    return;
  }
  busy = true;
  try { await runTurn(next); } finally { busy = false; }
  void pump();
}
createInterface({ input: process.stdin })
  .on('line', (line) => {
    if (!line.trim()) return;
    let message;
    try { message = JSON.parse(line); } catch { return; }
    if (message.type !== 'user') return;
    const content = message.message?.content;
    queue.push(typeof content === 'string' ? content : JSON.stringify(content));
    void pump();
  })
  .on('close', () => { stdinEnded = true; void pump(); });
`;

function writeFakeCli(bin) {
  const script = join(bin, 'fake-claude.mjs');
  writeFileSync(script, FAKE_CLI, 'utf8');
  if (isWindows) {
    writeFileSync(
      join(bin, 'claude.cmd'),
      `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`,
      'utf8',
    );
    return;
  }
  writeFileSync(join(bin, 'claude'), `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`, {
    mode: 0o755,
  });
}

/* ------------------------------------------------------------------ стенд */

/** Копия сервера: правки и поломки — в ней, рабочий стенд их не видит. */
function buildStand(stand) {
  const serverFrom = join(REPO, 'apps', 'server');
  const serverTo = join(stand, 'apps', 'server');
  cpSync(join(serverFrom, 'src'), join(serverTo, 'src'), {
    recursive: true,
    filter: (source) =>
      !/\.(test|spec)\.[cm]?[jt]s$/.test(source) && !/[\\/]__fixtures__([\\/]|$)/.test(source),
  });
  copyFileSync(join(serverFrom, 'package.json'), join(serverTo, 'package.json'));
  // Зависимости — ссылкой: копировать их незачем, а менять их проверка не
  // будет. Ссылка снимается первой при уборке (`unlinkStand`). Контракты сервер
  // берёт через неё же (`@agentdeck/contracts`), а сторожу нужен лишь каталог:
  // пустой — чтобы правка контрактов соседним агентом не перезапускала стенд
  // посреди сценария.
  symlinkSync(join(serverFrom, 'node_modules'), join(serverTo, 'node_modules'), 'junction');
  mkdirSync(join(stand, 'packages', 'contracts', 'src'), { recursive: true });
  return serverTo;
}

/** Снять ссылки ДО удаления папки: удаление не должно пройти по ним в репозиторий. */
function unlinkStand(stand) {
  for (const link of [join(stand, 'apps', 'server', 'node_modules')]) {
    try {
      unlinkSync(link);
    } catch {
      try {
        rmdirSync(link);
      } catch {
        /* ссылки нет */
      }
    }
  }
}

async function fetchOk(url, ms = 1_500) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(ms) });
    return res.ok;
  } catch {
    return false;
  }
}

let timedOut = false;

async function waitUntil(fn, seconds, stepMs = 250) {
  const until = Date.now() + seconds * 1000;
  while (Date.now() < until) {
    if (timedOut) throw new NotChecked('истёк предел прогона (RESTART_DEADLINE_MS)');
    const value = await fn();
    if (value) return value;
    await wait(stepMs);
  }
  return undefined;
}

/**
 * Сообщение в чат. Ответ маршрута — поток хода (SSE) до его конца: ждём только
 * статус, а поток дочитываем в фоне — его оборвёт убитый сервер, и это не сбой.
 */
async function sendChat(body) {
  const res = await fetch(`${PANEL}/api/chat/send`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (res.status >= 300) return { status: res.status, text: await res.text() };
  void res
    .text()
    .then(() => undefined)
    .catch(() => undefined);
  return { status: res.status, text: '' };
}

async function api(method, path, body) {
  const res = await fetch(`${PANEL}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { status: res.status, text, json };
}

/** Pid процесса, слушающего порт панели, — это сам сервер, а не сторож. */
function listenerPid(port) {
  try {
    if (isWindows) {
      const out = execFileSync('netstat', ['-ano', '-p', 'TCP'], {
        encoding: 'utf8',
        windowsHide: true,
      });
      for (const line of out.split(/\r?\n/)) {
        const parts = line.trim().split(/\s+/);
        if (parts[1] === `127.0.0.1:${port}` && parts[3] === 'LISTENING') return Number(parts[4]);
      }
      return undefined;
    }
    const out = execFileSync('lsof', ['-ti', `tcp:${port}`, '-sTCP:LISTEN'], { encoding: 'utf8' });
    return Number(out.trim().split(/\s+/)[0]) || undefined;
  } catch {
    return undefined;
  }
}

function alive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

/**
 * Таблица процессов машины — ТОЛЬКО для чтения: номер, родитель, время старта,
 * командная строка. Снимать по ней нельзя ничего: процесс снимается по
 * записанному номеру, и таблица лишь подтверждает, что под номером всё ещё
 * наш процесс (номер мог достаться другому).
 */
function processTable() {
  const table = new Map();
  try {
    if (isWindows) {
      const script = [
        "$epoch = [datetime]'1970-01-01'",
        'Get-CimInstance Win32_Process | ForEach-Object { [pscustomobject]@{ p = $_.ProcessId; pp = $_.ParentProcessId; c = [int64](($_.CreationDate.ToUniversalTime() - $epoch).TotalMilliseconds); cmd = [string]$_.CommandLine } } | ConvertTo-Json -Compress',
      ].join('; ');
      const out = execFileSync(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', script],
        { encoding: 'utf8', windowsHide: true, timeout: 60_000, maxBuffer: 64 * 1024 * 1024 },
      );
      for (const row of JSON.parse(out)) {
        table.set(row.p, { pid: row.p, parent: row.pp, created: row.c, command: row.cmd ?? '' });
      }
      return table;
    }
    const out = execFileSync('ps', ['-eo', 'pid=,ppid=,etimes=,args='], { encoding: 'utf8' });
    const now = Date.now();
    for (const line of out.split('\n')) {
      const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(line);
      if (!match) continue;
      const pid = Number(match[1]);
      table.set(pid, {
        pid,
        parent: Number(match[2]),
        created: now - Number(match[3]) * 1000,
        command: match[4],
      });
    }
  } catch {
    /* таблицы нет — снимать по номерам без подтверждения никто не будет */
  }
  return table;
}

/**
 * Снять процесс по записанному номеру — если под номером всё ещё наш: жив,
 * запущен после старта прогона, командная строка несёт метку прогона. С ним —
 * только его настоящие потомки (`lib/kill-tree.mjs`: ребёнок создан не раньше
 * родителя), не `taskkill /T`: тот идёт по номерам родителей, которые Windows не
 * чистит, и 27.09 так погиб чужой отвязанный сторож стенда владельца. Никогда по
 * имени, порту или шаблону.
 */
function stopOwn(pid, mark, table = processTable()) {
  if (!pid || !alive(pid)) return false;
  const row = table.get(pid);
  if (!row || row.created < STARTED_AT - 5_000 || !row.command.includes(mark)) return false;
  // Номер сверен с таблицей только что: снятие дерева сверяет время создания
  // корня с этим мигом и берёт лишь потомков, созданных не раньше родителя.
  return killProcessTree(pid, { spawnedAt: Date.now() }).length > 0;
}

/** Свой ребёнок — по объекту процесса: тот знает, вышел ли он, номер не чужой. */
function stopChild(child) {
  if (child && child.exitCode === null && child.signalCode === null) child.kill();
}

/**
 * Номер сервера под сторожем: ребёнок сторожа (сторож — наш живой процесс, его
 * номер не чужой), запущенный после него, с точкой входа сервера.
 */
function serverOf(watchPid, table = processTable()) {
  for (const row of table.values()) {
    if (
      row.parent === watchPid &&
      row.created >= STARTED_AT - 5_000 &&
      /src[\\/]index\.ts/.test(row.command)
    )
      return row.pid;
  }
  return undefined;
}

/**
 * То же, но с повтором: под нагрузкой (прогон группы) снимок процессов
 * Windows приходит пустым или без свежего ребёнка — один промах ещё не
 * «сервера нет». Таблица отдаётся та, в которой сервер нашёлся.
 */
async function serverUnder(watchPid, attempts = 5) {
  let table = new Map();
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    table = processTable();
    const pid = serverOf(watchPid, table);
    if (pid) return { table, pid };
    await wait(1_000);
  }
  return { table, pid: undefined };
}

/** Что из прогона ещё живо: чтение по метке, для отчёта; снимать так нельзя. */
function leftovers(mark) {
  return [...processTable().values()].filter(
    (row) =>
      row.pid !== process.pid && row.created >= STARTED_AT - 5_000 && row.command.includes(mark),
  );
}

/** Посреднику — «закончи CLI»: он доводит его до выхода и уходит сам. */
async function endRelay(relay) {
  const pipe = relay?.pipe;
  if (!pipe) return;
  await new Promise((resolveEnd) => {
    const socket = connect(pipe);
    const timer = setTimeout(() => {
      socket.destroy();
      resolveEnd();
    }, 3_000);
    socket.on('error', () => {
      clearTimeout(timer);
      resolveEnd();
    });
    socket.on('connect', () => {
      // Посредник с ключом слушает только того, кто начал с приветствия.
      if (relay.token)
        socket.write(`${JSON.stringify({ type: 'relay_hello', token: relay.token })}\n`);
      socket.write('{"type":"relay_end"}\n');
    });
    socket.on('close', () => {
      clearTimeout(timer);
      resolveEnd();
    });
  });
}

/** Строки pids.txt фальшивого CLI: pid, сессия, как поднят. */
function cliStarts(state) {
  const file = join(state, 'pids.txt');
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const [pid, session, how] = line.split(' ');
      return { pid: Number(pid), session, how };
    });
}

function ledger(appData) {
  try {
    const parsed = JSON.parse(readFileSync(join(appData, 'runs.json'), 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/* ------------------------------------------------------------------ интерфейс */

async function feedText(page) {
  try {
    return await page.locator('body').innerText({ timeout: 3_000 });
  } catch {
    return '';
  }
}

/** Текст открытого модального окна (пусто — окна нет); снимок — в RESTART_SHOTS. */
async function openDialogText(page) {
  const dialog = page.locator('[role="dialog"], [role="alertdialog"]').first();
  if (!(await dialog.count())) return '';
  if (process.env.RESTART_SHOTS) {
    await page
      .screenshot({ path: join(process.env.RESTART_SHOTS, `dialog-${Date.now()}.png`) })
      .catch(() => undefined);
  }
  return (await dialog.innerText({ timeout: 3_000 }).catch(() => '?')).replace(/\s+/g, ' ');
}

/** Сколько раз каждый знак потока виден в ленте. */
function tokenCounts(text, prefix, from, to) {
  const counts = [];
  for (let i = from; i <= to; i += 1) {
    const token = `${prefix}${String(i).padStart(2, '0')}`;
    counts.push([token, (text.match(new RegExp(`\\b${token}\\b`, 'g')) ?? []).length]);
  }
  return counts;
}

function describeCounts(counts) {
  const missing = counts.filter(([, n]) => n === 0).map(([t]) => t);
  const doubled = counts.filter(([, n]) => n > 1).map(([t, n]) => `${t}×${n}`);
  return { ok: missing.length === 0 && doubled.length === 0, missing, doubled };
}

async function waitToken(page, token, seconds) {
  return waitUntil(
    async () => new RegExp(`\\b${token}\\b`).test(await feedText(page)),
    seconds,
    300,
  );
}

/**
 * Поток в ленте ровно один раз на знак: проверяется, пока ход ИДЁТ (после
 * конца ленту рисует транскрипт, и он спрятал бы дыру потока).
 */
async function streamIntact(page, prefix, from, to, label) {
  const text = await feedText(page);
  const verdict = describeCounts(tokenCounts(text, prefix, from, to));
  check(
    verdict.ok,
    `${label}: знаки ${prefix}${String(from).padStart(2, '0')}…${prefix}${to} в ленте по одному разу`,
    verdict.ok
      ? ''
      : `нет: ${verdict.missing.join(' ') || '—'}; повторы: ${verdict.doubled.join(' ') || '—'}`,
  );
}

async function runDone(key, seconds) {
  return waitUntil(
    async () => {
      const res = await api('GET', '/api/chat/active').catch(() => undefined);
      if (!res || res.status !== 200 || !Array.isArray(res.json)) return false;
      return !res.json.some(
        (run) => (run.chatId === key || run.sessionId === key) && run.status === 'running',
      );
    },
    seconds,
    500,
  );
}

/* ------------------------------------------------------------------ сценарии */

async function scenarioA(ctx) {
  const { page, state } = ctx;
  console.log('\n— A: сервер убит жёстко, пока агент ждёт разрешения');
  const sent = await sendChat({
    chatId: 'new-restart-a',
    prompt: 'SCENARIO:A поток, вопрос прав, фон',
    projectPath: ctx.work,
  });
  if (!check(sent.status < 300, `ход A принят: ${sent.status}`, sent.status < 300 ? '' : sent.text))
    throw new NotChecked('ход не принят');
  const sid = await waitUntil(() => {
    const file = join(state, 'session.txt');
    return existsSync(file) ? readFileSync(file, 'utf8').trim() : undefined;
  }, 30);
  if (!sid) throw new NotChecked('фальшивый CLI не поднялся');
  ctx.sid = sid;
  await page.goto(`${WEB}/chat?id=${sid}`, { waitUntil: 'domcontentloaded' });
  check(Boolean(await waitToken(page, 'a05', 30)), 'поток хода A виден в ленте до перезапуска');
  const allow = page.getByRole('button', { name: 'Разрешить', exact: true });
  const card = await waitUntil(async () => (await allow.count()) > 0, 30, 300);
  check(Boolean(card), 'карточка прав видна до перезапуска');

  const cliPid = cliStarts(state)[0]?.pid;
  // Номер сервера — от сторожа (наш живой ребёнок), а не по порту: порт лишь
  // подтверждает, что это тот самый сервер.
  const { table, pid: serverPid } = await serverUnder(watch.pid);
  if (!serverPid) throw new NotChecked('не нашёл сервер среди детей сторожа');
  check(
    serverPid === listenerPid(PANEL_PORT),
    'порт панели слушает ребёнок сторожа',
    `сервер ${serverPid}`,
  );
  ctx.cliPid = cliPid;
  if (!stopOwn(serverPid, 'index.ts', table)) throw new NotChecked('сервер не снялся по номеру');
  check(
    Boolean(await waitUntil(() => !alive(serverPid), 10)),
    `сервер ${serverPid} убит жёстко посреди вопроса прав`,
  );
  const back = await waitUntil(async () => {
    const pid = listenerPid(PANEL_PORT);
    return pid && pid !== serverPid && (await fetchOk(`${PANEL}/api/system`)) ? pid : undefined;
  }, 60);
  check(
    Boolean(back),
    'сторож поднял упавший сервер сам',
    back ? `новый pid ${back}` : 'нет за 60 с',
  );
  if (!back) throw new NotChecked('сервер не вернулся');

  const cardAgain = await waitUntil(async () => (await allow.count()) > 0, 75, 500);
  check(Boolean(cardAgain), 'после перезапуска карточка прав снова видна (запрос не отклонён)');
  const early = existsSync(join(state, 'decision-a.json'))
    ? readFileSync(join(state, 'decision-a.json'), 'utf8')
    : '';
  check(!early, 'агент не получил отказа за время перезапуска', early || '');
  const dialog = await openDialogText(page);
  check(!dialog, 'после перезапуска ленту не заслоняет окно', dialog.slice(0, 300));
  // Что ответил сервер на клик — чтобы красное «не дошло» называло причину
  // (410 «истекло», `ok:false` — не нашёл запроса, клика не было вовсе).
  const answers = [];
  const onAnswer = (response) => {
    if (!response.url().includes('/permission-decision')) return;
    void response
      .text()
      .then((body) => answers.push(`${response.status()} ${body.slice(0, 200)}`))
      .catch(() => answers.push(`${response.status()}`));
  };
  page.on('response', onAnswer);
  if (cardAgain)
    await allow
      .first()
      .click({ timeout: 10_000 })
      .catch(() => undefined);
  const decision = await waitUntil(() => {
    const file = join(state, 'decision-a.json');
    return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : undefined;
  }, 30);
  page.off('response', onAnswer);
  check(
    decision?.behavior === 'allow',
    'ответ «Разрешить» из интерфейса дошёл до CLI',
    decision
      ? JSON.stringify(decision)
      : `решения нет; сервер на клик: ${answers.join(' | ') || 'запроса не было'}`,
  );
  check(Boolean(await waitToken(page, 'a12', 30)), 'поток хода A продолжился после ответа');
  await streamIntact(page, 'a', 1, 12, 'A посреди хода');
  check(Boolean(await runDone(sid, 40)), 'ход A закончился');
  const starts = cliStarts(state);
  check(
    starts.length === 1 && alive(cliPid),
    'процесс CLI пережил перезапуск: он один и жив',
    `запусков ${starts.length}, pid ${cliPid} ${alive(cliPid) ? 'жив' : 'мёртв'}`,
  );
}

async function scenarioB(ctx) {
  const { page, state, serverDir } = ctx;
  console.log('\n— B: правка файла сервера посреди потока');
  const before = listenerPid(PANEL_PORT);
  const sent = await sendChat({
    chatId: ctx.sid,
    sessionId: ctx.sid,
    prompt: 'SCENARIO:B поток через перезапуск сторожа',
  });
  check(sent.status < 300, `ход B принят: ${sent.status}`, sent.status < 300 ? '' : sent.text);
  check(Boolean(await waitToken(page, 'b04', 30)), 'поток хода B виден до правки');
  writeFileSync(
    join(serverDir, 'src', 'zz-restart-touch.ts'),
    `export const touched = ${Date.now()};\n`,
  );
  const after = await waitUntil(async () => {
    const pid = listenerPid(PANEL_PORT);
    return pid && pid !== before && (await fetchOk(`${PANEL}/api/system`)) ? pid : undefined;
  }, 60);
  check(
    Boolean(after),
    'сторож перезапустил сервер по правке',
    after ? `${before} → ${after}` : 'нет',
  );
  check(Boolean(await waitToken(page, 'b26', 45)), 'поток хода B дошёл до конца после перезапуска');
  await streamIntact(page, 'b', 1, 26, 'B посреди хода');
  check(Boolean(await runDone(ctx.sid, 30)), 'ход B закончился');
  const starts = cliStarts(state);
  check(
    starts.length === 1 && alive(ctx.cliPid),
    'процесс CLI тот же после перезапуска сторожа',
    `запусков ${starts.length}`,
  );
  // Фоновую команду запускает ход A: без него проверять нечего.
  if (!ONLY.has('A')) return;
  const marker = await waitUntil(() => existsSync(join(state, 'bg-marker.txt')), 30);
  check(Boolean(marker), 'фоновая команда хода A дожила и написала метку');
  check(
    Boolean(await waitToken(page, 'w03', 45)),
    'агент сам начал ход по концу фона — он в ленте',
  );
}

async function scenarioC(ctx) {
  const { page, serverDir, watchLog } = ctx;
  console.log('\n— C: синтаксическая ошибка в файле сервера');
  const before = listenerPid(PANEL_PORT);
  const sent = await sendChat({
    chatId: ctx.sid,
    sessionId: ctx.sid,
    prompt: 'SCENARIO:C поток через сломанную правку',
  });
  check(sent.status < 300, `ход C принят: ${sent.status}`, sent.status < 300 ? '' : sent.text);
  check(Boolean(await waitToken(page, 'c04', 30)), 'поток хода C виден до поломки');
  const logSize = existsSync(watchLog) ? readFileSync(watchLog, 'utf8').length : 0;
  // Ломается модуль из графа точки входа: сирота, которого никто не
  // импортирует, сервер не уронил бы и без пробы.
  const touch = join(serverDir, 'src', 'lib', 'empty-body.ts');
  const original = readFileSync(touch, 'utf8');
  writeFileSync(touch, `${original}\nexport const broken = ;\n`);
  let answered = 0;
  let failed = 0;
  let samePid = true;
  for (let i = 0; i < 16; i += 1) {
    await wait(500);
    if (await fetchOk(`${PANEL}/api/system`)) answered += 1;
    else failed += 1;
    if (listenerPid(PANEL_PORT) !== before) samePid = false;
  }
  check(
    failed === 0 && samePid,
    'прежний сервер отвечал всё время, пока правка сломана',
    `ответов ${answered}, отказов ${failed}, pid ${samePid ? 'тот же' : 'сменился'}`,
  );
  const said = (existsSync(watchLog) ? readFileSync(watchLog, 'utf8') : '').slice(logSize);
  check(
    /empty-body/.test(said) && /не (поднимается|собирается)/i.test(said),
    'сторож назвал сломанный файл и оставил прежний сервер',
    said.trim().split(/\r?\n/).slice(-3).join(' | ').slice(0, 300),
  );
  check(Boolean(await waitToken(page, 'c20', 30)), 'поток хода C шёл, пока правка сломана');
  writeFileSync(touch, `${original}\n// исправлено ${Date.now()}\n`);
  const after = await waitUntil(async () => {
    const pid = listenerPid(PANEL_PORT);
    return pid && pid !== before && (await fetchOk(`${PANEL}/api/system`)) ? pid : undefined;
  }, 60);
  check(
    Boolean(after),
    'исправленная правка — обычный перезапуск',
    after ? `${before} → ${after}` : 'нет',
  );
  check(Boolean(await waitToken(page, 'c28', 45)), 'поток хода C дошёл до конца');
  await streamIntact(page, 'c', 1, 28, 'C посреди хода');
  check(Boolean(await runDone(ctx.sid, 30)), 'ход C закончился');
}

async function scenarioD(ctx) {
  const { page, state, appData } = ctx;
  console.log('\n— D: посредник убит снаружи (отрицательный)');
  const sent = await sendChat({
    chatId: ctx.sid,
    sessionId: ctx.sid,
    prompt: 'SCENARIO:D поток, которому убьют посредника',
  });
  check(sent.status < 300, `ход D принят: ${sent.status}`, sent.status < 300 ? '' : sent.text);
  check(Boolean(await waitToken(page, 'd04', 30)), 'поток хода D виден');
  const entry = ledger(appData).find((item) => item.sessionId === ctx.sid && item.relay?.pid);
  const relayPid = entry?.relay?.pid;
  if (!check(Boolean(relayPid), 'посредник записан в журнале прогонов', `pid ${relayPid ?? '—'}`))
    return;
  check(stopOwn(relayPid, 'live-relay'), 'посредник снят по своему номеру', `pid ${relayPid}`);
  const done = await runDone(ctx.sid, 45);
  check(Boolean(done), 'прогон не повис: закончился после смерти посредника');
  const text = await waitUntil(async () => {
    const body = await feedText(page);
    return /процесс чата потерян/i.test(body) ? body : undefined;
  }, 20);
  const body = text ?? (await feedText(page));
  // Как это видит человек — снимок ленты с объяснением потери процесса.
  if (process.env.RESTART_SHOTS)
    await page
      .screenshot({ path: join(process.env.RESTART_SHOTS, 'd-process-lost.png') })
      .catch(() => undefined);
  check(
    Boolean(text) && !/relay closed|relay .* unreachable|Не удалось запустить/i.test(body),
    'лента говорит человеческими словами, без «relay closed»',
    text
      ? ''
      : body
          .split(/\r?\n/)
          .filter((line) => /relay|запустить|ошибк/i.test(line))
          .slice(0, 3)
          .join(' | '),
  );
  const startsBefore = cliStarts(state).length;
  const again = await sendChat({
    chatId: ctx.sid,
    sessionId: ctx.sid,
    prompt: 'SCENARIO:F продолжение после потери',
  });
  check(again.status < 300, `следующее сообщение принято: ${again.status}`);
  check(
    Boolean(await waitToken(page, 'f03', 40)),
    'разговор продолжился: ответ нового хода в ленте',
  );
  const starts = cliStarts(state);
  const last = starts.at(-1);
  check(
    starts.length === startsBefore + 1 && last?.how === 'resume' && last.session === ctx.sid,
    'продолжение — новый процесс с --resume той же сессии',
    `запусков ${starts.length}, последний ${last?.how ?? '—'}`,
  );
}

/* ------------------------------------------------------------------ сценарий R: настоящий CLI */

const R_TOOL = 'toolu_restart_r1';
const R_DONE = 'R-FINISHED-7';
const R_MARKER = 'r-marker.txt';
/**
 * Команда, которую CLI обязан спросить в любом режиме, кроме обхода прав: удаление
 * папки. Запись одним `echo >` в папке проекта режим правок пропускает без вопроса.
 */
const R_COMMAND = ['rm', '-rf', 'r-build', '&&', 'echo', 'restart-ok', '>', R_MARKER].join(' ');

/**
 * Стаб модели: главный запрос (с инструментами) без результата инструмента —
 * вызов Bash, который CLI обязан спросить у человека; с результатом — текст
 * конца хода. Побочные запросы CLI (без инструментов) — короткий текст.
 */
async function startModelStub() {
  const seen = [];
  const sse = (res, blocks, stop) => {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    const ev = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    ev('message_start', {
      type: 'message_start',
      message: {
        id: `msg_r${seen.length}`,
        type: 'message',
        role: 'assistant',
        model: 'stub-restart',
        content: [],
        stop_reason: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    });
    blocks.forEach((block, index) => {
      if (block.type === 'text') {
        ev('content_block_start', {
          type: 'content_block_start',
          index,
          content_block: { type: 'text', text: '' },
        });
        ev('content_block_delta', {
          type: 'content_block_delta',
          index,
          delta: { type: 'text_delta', text: block.text },
        });
      } else {
        ev('content_block_start', {
          type: 'content_block_start',
          index,
          content_block: { type: 'tool_use', id: block.id, name: block.name, input: {} },
        });
        ev('content_block_delta', {
          type: 'content_block_delta',
          index,
          delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) },
        });
      }
      ev('content_block_stop', { type: 'content_block_stop', index });
    });
    ev('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: stop },
      usage: { output_tokens: 1 },
    });
    ev('message_stop', { type: 'message_stop' });
    res.end();
  };
  const server = createHttpServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      let body = {};
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      } catch {
        /* не JSON — побочный запрос */
      }
      if (req.url?.includes('count_tokens')) return res.end(JSON.stringify({ input_tokens: 1 }));
      if (!req.url?.includes('/messages')) return res.end('{}');
      if (!body.tools?.length) return sse(res, [{ type: 'text', text: 'ок' }], 'end_turn');
      // CLI 2.1.28x дописывает в конец служебные сообщения роли system — результат
      // инструмента ищется в последнем сообщении человека, а не в последнем вообще.
      const last = body.messages?.findLast((message) => message.role === 'user');
      const results = (Array.isArray(last?.content) ? last.content : []).filter(
        (block) => block.type === 'tool_result',
      );
      const text = (block) =>
        typeof block.content === 'string' ? block.content : JSON.stringify(block.content);
      seen.push({
        at: Date.now(),
        results: results.map((block) => ({
          id: block.tool_use_id,
          error: block.is_error === true,
          text: text(block).slice(0, 300),
        })),
      });
      if (results.length === 0) {
        return sse(
          res,
          [
            {
              type: 'tool_use',
              id: R_TOOL,
              name: 'Bash',
              input: { command: R_COMMAND, description: 'Clean the build, write the marker' },
            },
          ],
          'tool_use',
        );
      }
      return sse(res, [{ type: 'text', text: R_DONE }], 'end_turn');
    });
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    seen,
    close: () => server.close(),
  };
}

/** Номера процессов прогона чата по журналу панели (CLI, посредник). */
function runPids(appData, keys) {
  const entry = ledger(appData).find(
    (row) => keys.includes(row.key) || keys.includes(row.sessionId),
  );
  return entry ? { pid: entry.pid, relay: entry.relay?.pid } : {};
}

/** Результаты инструмента в ходе R: у настоящего CLI — со стаба модели, у фальшивого — из его файла. */
function rResults(ctx) {
  if (ctx.stub) return ctx.stub.seen.flatMap((request) => request.results);
  const file = join(ctx.state, 'r-results.jsonl');
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

async function scenarioR(ctx) {
  const { page, work, appData, stub } = ctx;
  console.log(
    `\n— R: ${REAL ? 'настоящий' : 'фальшивый'} CLI ждёт разрешения, сервер убит жёстко, сигнал «жду» × перезапуск`,
  );
  mkdirSync(join(work, 'r-build'), { recursive: true });
  writeFileSync(join(work, 'r-build', 'out.txt'), 'delete me', 'utf8');
  const sent = await sendChat({
    chatId: 'new-restart-r',
    prompt: 'SCENARIO:R запиши метку',
    projectPath: work,
  });
  if (!check(sent.status < 300, `ход R принят: ${sent.status}`, sent.status < 300 ? '' : sent.text))
    throw new NotChecked('ход не принят');
  const run = await waitUntil(async () => {
    const res = await api('GET', '/api/chat/active').catch(() => undefined);
    const found = Array.isArray(res?.json)
      ? res.json.find((item) => item.status === 'running' && item.sessionId)
      : undefined;
    return found;
  }, 60);
  if (!run) throw new NotChecked('CLI не начал ход (нет sessionId)');
  ctx.sid = run.sessionId;
  await page.goto(`${WEB}/chat?id=${run.sessionId}`, { waitUntil: 'domcontentloaded' });
  const allow = page.getByRole('button', { name: 'Разрешить', exact: true });
  const card = await waitUntil(async () => (await allow.count()) > 0, 60, 300);
  const cardAt = Date.now();
  check(
    Boolean(card),
    'карточка прав CLI видна до перезапуска',
    card
      ? ''
      : `модель: ${JSON.stringify(stub?.seen ?? rResults(ctx))}; входящие: ${(await api('GET', '/api/chat/inbox')).text.slice(0, 400)}; лента: ${(await feedText(page)).replace(/s+/g, ' ').slice(-600)}`,
  );
  if (!card) throw new NotChecked('карточки нет');
  const before = runPids(appData, [run.chatId, run.sessionId, 'new-restart-r']);
  const cliPid = before.pid;
  if (REAL) realCliPid = cliPid ?? 0;
  check(Boolean(cliPid && alive(cliPid)), 'процесс CLI записан в журнале и жив', `pid ${cliPid}`);

  const { table, pid: serverPid } = await serverUnder(watch.pid);
  if (!serverPid) throw new NotChecked('не нашёл сервер среди детей сторожа');
  if (!stopOwn(serverPid, 'index.ts', table)) throw new NotChecked('сервер не снялся по номеру');
  check(
    Boolean(await waitUntil(() => !alive(serverPid), 10)),
    `сервер ${serverPid} убит жёстко посреди вопроса прав`,
  );
  const back = await waitUntil(async () => {
    const pid = listenerPid(PANEL_PORT);
    return pid && pid !== serverPid && (await fetchOk(`${PANEL}/api/system`)) ? pid : undefined;
  }, 60);
  check(
    Boolean(back),
    'сторож поднял упавший сервер сам',
    back ? `новый pid ${back}` : 'нет за 60 с',
  );
  if (!back) throw new NotChecked('сервер не вернулся');

  // Держим вопрос дольше срока молчания MCP-вызова: без сигнала «жду человека»
  // CLI оборвал бы вызов, и ответ из карточки уже ничего бы не запустил.
  const holdLeft = REAL_HOLD_MS - (Date.now() - cardAt);
  if (holdLeft > 0) await wait(holdLeft);
  check(
    Date.now() - cardAt > REAL_IDLE_MS,
    `вопрос прав ждал дольше срока молчания CLI (${REAL_IDLE_MS} мс)`,
    `${Date.now() - cardAt} мс`,
  );
  const aborted = rResults(ctx).filter((result) => result.error);
  check(
    aborted.length === 0,
    'CLI не оборвал вызов прав за время перезапуска и ожидания',
    aborted.map((result) => result.text).join(' | '),
  );
  const cardAgain = await waitUntil(async () => (await allow.count()) > 0, 60, 500);
  check(Boolean(cardAgain), 'после перезапуска карточка прав снова видна');
  const dialog = await openDialogText(page);
  check(!dialog, 'после перезапуска ленту не заслоняет окно', dialog.slice(0, 300));
  const answers = [];
  const onAnswer = (response) => {
    if (!response.url().includes('/permission-decision')) return;
    void response
      .text()
      .then((body) => answers.push(`${response.status()} ${body.slice(0, 200)}`))
      .catch(() => answers.push(`${response.status()}`));
  };
  page.on('response', onAnswer);
  if (cardAgain)
    await allow
      .first()
      .click({ timeout: 10_000 })
      .catch(() => undefined);
  const ran = await waitUntil(
    () => existsSync(join(work, R_MARKER)) && !existsSync(join(work, 'r-build')),
    60,
  );
  page.off('response', onAnswer);
  check(
    Boolean(ran),
    '«Разрешить» из интерфейса дошло до CLI: команда выполнилась',
    ran ? '' : `метки нет; сервер на клик: ${answers.join(' | ') || 'запроса не было'}`,
  );
  const result = rResults(ctx).find((item) => item.id === R_TOOL && !item.error);
  check(
    Boolean(result),
    'модель получила результат команды без ошибки',
    JSON.stringify(rResults(ctx)),
  );
  check(Boolean(await waitToken(page, R_DONE, 45)), 'ответ конца хода виден в ленте');
  check(Boolean(await runDone(run.sessionId, 45)), 'ход R закончился');
  const after = runPids(appData, [run.chatId, run.sessionId, 'new-restart-r']);
  check(
    after.pid === cliPid && alive(cliPid),
    'процесс CLI пережил перезапуск: тот же номер и жив',
    `до ${cliPid}, после ${after.pid}`,
  );
  ctx.cliPid = cliPid;
}

/* ------------------------------------------------------------------ прогон */

// Порт занят — значит, на нём чужая панель (или прошлый прогон ещё идёт): сторож
// этой не поднимется, а проверка говорила бы с чужим сервером и читала бы его
// отказы как свои. Однажды так и было: «409 на первом же ходу» от соседа.
for (const port of [PANEL_PORT, WEB_PORT]) {
  if (listenerPid(port)) {
    console.log(
      `НЕ ПРОВЕРЕНО: порт ${port} уже занят (pid ${listenerPid(port)}) — задайте RESTART_PANEL_PORT / RESTART_WEB_PORT`,
    );
    process.exit(2);
  }
}

const root = mkdtempSync(join(tmpdir(), 'cc-chat-restart-'));
const home = join(root, 'home');
const config = join(root, 'config');
const bin = join(root, 'bin');
const state = join(root, 'state');
const work = join(root, 'project');
const stand = join(root, 'stand');
for (const dir of [home, config, bin, state, work]) mkdirSync(dir, { recursive: true });
writeFileSync(join(config, 'settings.json'), '{}\n', 'utf8');
// Настоящий CLI (сценарий R) берётся из PATH человека — фальшивый не кладётся.
if (!REAL) writeFakeCli(bin);
const stub = REAL ? await startModelStub() : undefined;
const serverDir = buildStand(stand);
const appData = join(config, 'agentdeck');
const watchLog = join(root, 'dev-watch.log');

const homeEnv = {
  HOME: home,
  USERPROFILE: home,
  CLAUDE_CONFIG_DIR: config,
  APPDATA: join(home, 'AppData', 'Roaming'),
  LOCALAPPDATA: join(home, 'AppData', 'Local'),
};
const base = Object.fromEntries(
  Object.entries(process.env).filter(
    ([key]) => !['PATH', ...Object.keys(homeEnv)].includes(key.toUpperCase()),
  ),
);
const PATH = [bin, process.env.PATH ?? process.env.Path].join(isWindows ? ';' : ':');

const logFd = openSync(watchLog, 'a');
const children = [];
const watch = spawn(process.execPath, [join(serverDir, 'src', 'lib', 'dev-watch.mjs')], {
  cwd: serverDir,
  env: {
    ...base,
    ...homeEnv,
    PATH,
    PORT: String(PANEL_PORT),
    WEB_PORT: String(WEB_PORT),
    // Перезапуск посреди хода — то, что проверяется; сторож его не откладывает.
    AGENTDECK_DEV_DEFER: '0',
    FAKE_STATE_DIR: state,
    FAKE_BG_MS: String(BG_MS),
    // Фальшивый CLI сценария R обрывает вызов прав по тишине, как настоящий; мост
    // шлёт «жду человека» чаще срока — иначе обрыв и был бы находкой.
    ...(REAL
      ? {}
      : {
          FAKE_MCP_IDLE_MS: String(REAL_IDLE_MS),
          AGENTDECK_PERM_PROGRESS_MS: process.env.RESTART_PERM_PROGRESS_MS ?? '2000',
        }),
    ...(stub
      ? {
          ANTHROPIC_BASE_URL: stub.url,
          ANTHROPIC_API_KEY: 'restart-stub',
          ANTHROPIC_AUTH_TOKEN: 'restart-stub',
          ANTHROPIC_MODEL: 'stub-restart',
          CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT: String(REAL_IDLE_MS),
          DISABLE_TELEMETRY: '1',
          DISABLE_AUTOUPDATER: '1',
          DISABLE_ERROR_REPORTING: '1',
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
          ...(process.env.RESTART_PERM_PROGRESS_MS !== undefined
            ? { AGENTDECK_PERM_PROGRESS_MS: process.env.RESTART_PERM_PROGRESS_MS }
            : { AGENTDECK_PERM_PROGRESS_MS: '5000' }),
        }
      : {}),
  },
  // Канал IPC — чтобы сторож ушёл сам, закрыв его: снимать его деревом нельзя.
  stdio: ['ignore', logFd, logFd, 'ipc'],
  windowsHide: true,
});
children.push(watch);
const web = spawn(
  process.execPath,
  [
    join('node_modules', 'vite', 'bin', 'vite.js'),
    '--port',
    String(WEB_PORT),
    '--strictPort',
    '--host',
    '127.0.0.1',
  ],
  {
    cwd: join(REPO, 'apps', 'web'),
    env: { ...base, ...homeEnv, PATH, API_PORT: String(PANEL_PORT), BROWSER: 'none' },
    stdio: 'ignore',
    windowsHide: true,
  },
);
children.push(web);

let exitCode = 0;
let browser;
/** Предел всего прогона: зависший шаг не должен оставить стенд жить без уборки. */
const DEADLINE_MS = Number(process.env.RESTART_DEADLINE_MS ?? 480_000);
const deadline = setTimeout(() => {
  timedOut = true;
}, DEADLINE_MS);
try {
  if (!(await waitUntil(() => fetchOk(`${PANEL}/api/system`), 60, 500)))
    throw new NotChecked('одноразовая панель не поднялась');
  if (!(await waitUntil(() => fetchOk(WEB, 3_000), 90, 500)))
    throw new NotChecked('одноразовый фронт не поднялся');
  console.log(`Панель ${PANEL} (сторож над копией сервера), фронт ${WEB}, папка ${root}`);
  browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  // Мастер первого запуска — модалка поверх ленты; он к проверке не относится.
  await bypassOnboarding(page, { language: 'ru' });
  const ctx = { page, state, work, serverDir, watchLog, appData, stub, sid: '', cliPid: 0 };
  // Разбор отказа руками: стенд стоит, сколько сказано, до сценариев.
  const hold = Number(process.env.RESTART_HOLD_MS ?? 0);
  if (hold > 0) {
    console.log(`стенд ждёт ${hold} мс: проект ${work}, состояние CLI ${state}`);
    await wait(hold);
  }
  const plan = [
    ['A', scenarioA],
    ['B', scenarioB],
    ['C', scenarioC],
    ['D', scenarioD],
    ['R', scenarioR],
  ];
  for (const [name, run] of plan) {
    if (!ONLY.has(name)) continue;
    if (name !== 'A' && name !== 'R' && !ctx.sid) {
      // Сценарии после A идут в том же разговоре: без него — отдельный ход.
      const first = await sendChat({
        chatId: 'new-restart-x',
        prompt: 'SCENARIO:E разгон',
        projectPath: work,
      });
      if (first.status >= 300) throw new NotChecked('разгонный ход не принят');
      ctx.sid = await waitUntil(() => {
        const file = join(state, 'session.txt');
        return existsSync(file) ? readFileSync(file, 'utf8').trim() : undefined;
      }, 30);
      ctx.cliPid = cliStarts(state)[0]?.pid ?? 0;
      await runDone(ctx.sid, 30);
      await page.goto(`${WEB}/chat?id=${ctx.sid}`, { waitUntil: 'domcontentloaded' });
    }
    try {
      await run(ctx);
    } catch (error) {
      if (!(error instanceof NotChecked)) throw error;
      check(false, `сценарий ${name} оборван: ${error.message}`);
      break;
    }
  }
} catch (error) {
  if (error instanceof NotChecked) {
    console.log(`\nНЕ ПРОВЕРЕНО: ${error.message}`);
    exitCode = 2;
  } else {
    console.log(`\nСБОЙ ПРОВЕРКИ: ${error?.stack ?? error}`);
    console.log(readFileSync(watchLog, 'utf8').split(/\r?\n/).slice(-25).join('\n'));
    exitCode = 1;
  }
} finally {
  clearTimeout(deadline);
  // Предел обрывает шаги, но не уборку: она идёт до конца всегда.
  timedOut = false;
  await Promise.race([browser?.close().catch(() => undefined), wait(5_000)]);
  // Уборка — только своё и только по номерам, ни одного дерева. Сторож
  // уходит сам, закрыв канал IPC, и гасит свой сервер; посредникам — «закончи
  // CLI», они уходят сами. Что не ушло — по записанному номеру, после сверки,
  // что номер всё ещё наш. Что осталось и после этого — строка отчёта.
  const server = serverOf(watch.pid);
  if (watch.connected) watch.disconnect();
  await waitUntil(() => watch.exitCode !== null || watch.signalCode !== null, 10, 200);
  stopChild(watch);
  stopChild(web);
  const entries = ledger(appData);
  for (const entry of entries) await endRelay(entry.relay);
  await waitUntil(
    () => entries.every((entry) => !entry.relay?.pid || !alive(entry.relay.pid)),
    8,
    250,
  );
  const table = processTable();
  if (server && table.get(server)?.parent === watch.pid) stopOwn(server, 'index.ts', table);
  for (const entry of entries) {
    for (const pid of new Set([entry.relay?.pid, entry.pid, ...(entry.pids ?? [])])) {
      stopOwn(pid, root, table);
    }
  }
  for (const start of cliStarts(state)) stopOwn(start.pid, root, table);
  // Настоящий CLI запущен панелью с конфигом прав из её временной папки (cc-perm-),
  // а не из папки прогона: его метка — она. Посредник уже просил его закончить.
  if (realCliPid && alive(realCliPid)) stopOwn(realCliPid, 'cc-perm-', table);
  stub?.close();
  await wait(1_000);
  const left = leftovers(root);
  if (realCliPid) {
    check(
      !alive(realCliPid),
      'настоящий CLI снят при уборке',
      alive(realCliPid) ? String(realCliPid) : '',
    );
  }
  check(
    left.length === 0,
    'за прогоном не осталось процессов',
    left.map((row) => `${row.pid} ${row.command.slice(0, 120)}`).join(' | '),
  );
  closeSync(logFd);
  await wait(800);
  if (exitCode !== 0 || rows.some((row) => !row.ok)) {
    const tail = readFileSync(watchLog, 'utf8').split(/\r?\n/).slice(-25).join('\n');
    console.log(`\nхвост журнала сторожа:\n${tail}`);
  }
  if (process.env.RESTART_KEEP_LOG)
    appendFileSync(process.env.RESTART_KEEP_LOG, readFileSync(watchLog, 'utf8'));
  unlinkStand(stand);
  const intact =
    existsSync(join(REPO, 'apps', 'server', 'node_modules')) &&
    existsSync(join(REPO, 'packages', 'contracts', 'package.json'));
  let linked = false;
  try {
    linked = lstatSync(join(stand, 'apps', 'server', 'node_modules')).isSymbolicLink();
  } catch {
    /* ссылки нет — так и должно быть */
  }
  if (intact && !linked) {
    try {
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
    } catch (error) {
      console.log(`\nпапку ${root} удалить не вышло: ${error.code ?? error.message}`);
    }
  } else console.log(`\nВНИМАНИЕ: ссылка стенда не снята — папка ${root} оставлена как есть`);
}

const bad = rows.filter((row) => !row.ok).length;
console.log(`\nитог: строк ${rows.length}, расхождений ${bad}`);
if (exitCode === 0 && bad > 0) exitCode = 1;
process.exit(exitCode);
