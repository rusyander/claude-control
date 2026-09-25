#!/usr/bin/env node
/**
 * Посредник живой сессии: держит трубы CLI вместо сервера панели.
 *
 * Зачем. Живая сессия (`live-session.ts`) ведёт разговор одним процессом CLI в
 * режиме потокового ввода, и его stdin — труба сервера. Сервер перезапускается
 * (`node --watch`, сторож, падение) — труба закрывается, CLI видит конец ввода и
 * выходит в конце хода, унося фоновые команды агента: гейты по 12 минут умирали
 * на полпути, группа стояла «ждёт фон» с мёртвым процессом (журнал 29, 60, 69).
 *
 * Как. Сервер запускает не CLI, а этот процесс — отвязанным (`detached`), с
 * описанием запуска в файле. Посредник поднимает CLI со своими трубами и слушает
 * именованный канал: сервер подключается, строки ввода идут в stdin CLI, вывод —
 * обратно. Сервер умер — посредник и CLI живут дальше, вывод копится в памяти;
 * новый сервер находит канал в журнале прогонов и подключается снова: сначала
 * накопленное, потом строка `relay_synced` с тем, что посредник знает о ходе.
 *
 * Строки `{"type":"relay_…"}` — служебные в обе стороны; CLI их не видит.
 * Обычный Node без зависимостей: исполняется голым `node`, без разбора типов.
 */
/* global process, setInterval, setTimeout */
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { createInterface } from 'node:readline';

const specFile = process.argv[2] ?? '';
const spec = JSON.parse(readFileSync(specFile, 'utf8'));
// В описании — окружение CLI с ключами контура: на диске ему не место дольше,
// чем нужно на чтение.
rmSync(specFile, { force: true });

/** Сколько вывода копим без сервера: ход с частичными сообщениями — мегабайты. */
const BUFFER_MAX = spec.bufferBytes ?? 16 * 1024 * 1024;
const STDERR_TAIL = 8192;
/** Сколько ждать сервер, чтобы отдать ему код выхода CLI, прежде чем уйти самим. */
const EXIT_GRACE_MS = spec.exitGraceMs ?? 60_000;
const IDLE_MS = spec.idleMs ?? 30 * 60_000;
const BACKGROUND_IDLE_MS = spec.backgroundIdleMs ?? 6 * 60 * 60_000;
const SERVICE = /^\{"type":"(?:system|result)"/;

let client;
let pending = [];
let pendingBytes = 0;
let busy = false;
let background = 0;
let stderr = '';
let exited;
/** Конец последнего хода или отключения сервера — от него считается простой. */
let lastActivity = Date.now();

const child = spawn(spec.command, spec.args, {
  cwd: spec.cwd,
  env: spec.env,
  shell: spec.shell,
  windowsHide: true,
});
child.on('error', (error) => finish(-1, error.message));
child.on('close', (code) => finish(code ?? 0));
child.stdin.on('error', () => undefined);
child.stderr.on('data', (chunk) => {
  stderr = (stderr + chunk.toString()).slice(-STDERR_TAIL);
});
createInterface({ input: child.stdout }).on('line', (line) => {
  if (!line.trim()) return;
  track(line);
  send(line);
});

/** Что посредник обязан знать о ходе сам: сервера в момент перезапуска нет. */
function track(line) {
  if (!SERVICE.test(line)) return;
  let raw;
  try {
    raw = JSON.parse(line);
  } catch {
    return;
  }
  if (raw.type === 'system' && raw.subtype === 'init') busy = true;
  if (raw.type === 'system' && raw.subtype === 'background_tasks_changed') {
    background = Array.isArray(raw.tasks) ? raw.tasks.length : 0;
  }
  if (raw.type === 'result') {
    busy = false;
    lastActivity = Date.now();
  }
}

function send(line) {
  if (client && !client.destroyed) {
    client.write(`${line}\n`);
    return;
  }
  pending.push(line);
  pendingBytes += line.length;
  // Переполнение — старое уходит: хвост хода с `result` важнее его начала,
  // текст ответа сервер всё равно дочитает из транскрипта.
  while (pendingBytes > BUFFER_MAX && pending.length > 1) {
    pendingBytes -= pending.shift().length;
  }
}

function synced() {
  return JSON.stringify({
    type: 'relay_synced',
    // Свой номер: сервер знает посредника по номеру, а поднимал его не сам.
    pid: process.pid,
    busy,
    background,
    childPid: child.pid ?? null,
    ...(exited ? { exited: true } : {}),
  });
}

function onClient(socket) {
  // Подключение одно: прежнее принадлежало умершему серверу.
  if (client && client !== socket) client.destroy();
  client = socket;
  socket.on('error', () => undefined);
  socket.on('close', () => {
    if (client !== socket) return;
    client = undefined;
    lastActivity = Date.now();
  });
  const backlog = pending;
  pending = [];
  pendingBytes = 0;
  for (const line of backlog) socket.write(`${line}\n`);
  socket.write(`${synced()}\n`);
  if (exited) {
    socket.write(`${exitLine()}\n`);
    socket.end(() => process.exit(0));
    return;
  }
  createInterface({ input: socket }).on('line', (line) => {
    if (!line.trim() || client !== socket) return;
    if (line.startsWith('{"type":"relay_')) return control(line);
    // Сообщение человека начинает ход раньше, чем CLI ответит `init`.
    busy = true;
    child.stdin.write(`${line}\n`);
  });
}

function control(line) {
  if (line.includes('"relay_end"')) child.stdin.end();
  if (line.includes('"relay_kill"')) killTree();
}

function killTree() {
  if (!child.pid) return;
  if (process.platform === 'win32') {
    // На Windows CLI живёт под `cmd.exe`: сигнал оболочке его не снимает.
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
    return;
  }
  try {
    child.kill('SIGTERM');
  } catch {
    // Уже вышел.
  }
}

function exitLine() {
  return JSON.stringify({
    type: 'relay_exit',
    code: exited.code,
    ...(exited.error ? { error: exited.error } : {}),
    stderr: stderr.trim(),
  });
}

function finish(code, error) {
  if (exited) return;
  exited = { code, ...(error ? { error } : {}) };
  if (client && !client.destroyed) {
    client.write(`${exitLine()}\n`);
    client.end(() => process.exit(0));
    setTimeout(() => process.exit(0), 5_000).unref();
    return;
  }
  // Сервера нет — ждём его немного, чтобы он узнал код выхода, а не гадал по pid.
  setTimeout(() => process.exit(0), EXIT_GRACE_MS).unref();
}

// Сервер не вернулся: простаивающий CLI без фона закрываем мягко, как закрыл бы
// пул (`LivePoolLimits`), — иначе сирота жил бы до перезагрузки машины.
const idleTimer = setInterval(() => {
  if (client || busy || exited) return;
  const limit = background > 0 ? BACKGROUND_IDLE_MS : IDLE_MS;
  if (Date.now() - lastActivity >= limit) child.stdin.end();
}, spec.idleCheckMs ?? 60_000);
idleTimer.unref();

const server = createServer(onClient);
server.on('error', (error) => {
  // Канал не поднялся — сервер к CLI не подключится никогда, держать его незачем.
  stderr = `${stderr}\nrelay: ${error.message}`.slice(-STDERR_TAIL);
  killTree();
});
if (process.platform !== 'win32') rmSync(spec.pipe, { force: true });
server.listen(spec.pipe);
process.on('exit', () => {
  if (process.platform !== 'win32') rmSync(spec.pipe, { force: true });
});
