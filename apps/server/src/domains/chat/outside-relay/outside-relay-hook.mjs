#!/usr/bin/env node
// Хук панели для сессий в терминале и VS Code — контроль с телефона.
//   PermissionRequest — вопрос агента или запрос прав уходит и на телефон; окно
//     на компьютере показывает его одновременно, принимается первое решение.
//   PostToolUse, Stop — сообщение, написанное с телефона посреди хода, агент
//     получает после ближайшего шага или вместо остановки.
// Любая неудача — выход без решения: CLI ведёт себя, как без хука. Хук не
// должен ни ронять, ни подвешивать сессию человека.
//
// Аргументы: --url <адрес панели> --token-file <файл токена>
/* global process, fetch, AbortSignal, setTimeout, Buffer */
import { closeSync, existsSync, fstatSync, openSync, readFileSync, readSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  findToolUseId,
  hasToolResult,
  messagesOutput,
  permissionOutput,
} from './outside-relay-hook-lib.mjs';

// Хук запускается голым node и сервер импортировать не может, поэтому сроки —
// копии; источник — константы `outside-relay.ts`, править оба места разом.
/** = `RELAY_MAX_MS`: дольше сервер запрос всё равно не держит. */
const MAX_MS = 50 * 60 * 1000;
const NETWORK_RETRIES = 3;
/**
 * Как часто хук смотрит, не ответили ли в окне, пока ждёт телефона. Сервер
 * считает хук мёртвым после `HOOK_SILENT_MS` тишины — срез должен быть короче.
 */
const WAIT_SLICE_MS = 3000;
/** Пауза перед повтором, пока панель недоступна (перезапуск). */
const RETRY_MS = 2000;
const TAIL_BYTES = 512 * 1024;
/**
 * Сколько хук ищет вызов в транскрипте и как часто. Прежней секунды не хватило
 * свежей сессии VS Code (25.10, e6600235): вопрос не попал в пересылку, и ответ
 * из Telegram ушёл копией сессии в панели. Хвост тут ни при чём — файл был
 * меньше `TAIL_BYTES`, у удачной сессии вызов лежал на том же месте; запись о
 * вызове ложится на диск позже старта хука. Диалог окна открыт всё это время,
 * так что ожидание CLI не держит.
 */
const FIND_MS = 10_000;
const FIND_EVERY_MS = 200;

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

function arg(name) {
  const at = process.argv.indexOf(name);
  return at >= 0 ? process.argv[at + 1] : undefined;
}

function readStdin() {
  return new Promise((resolve) => {
    let text = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => (text += chunk));
    process.stdin.on('end', () => resolve(text));
  });
}

/** Хвост транскрипта: длинная сессия весит мегабайты, нужный вызов — в конце. */
function readTail(path) {
  if (!path) return '';
  try {
    const fd = openSync(path, 'r');
    try {
      const size = fstatSync(fd).size;
      const length = Math.min(size, TAIL_BYTES);
      const buffer = Buffer.alloc(length);
      readSync(fd, buffer, 0, length, size - length);
      return buffer.toString('utf8');
    } finally {
      closeSync(fd);
    }
  } catch {
    return '';
  }
}

async function call(base, token, method, path, body, timeoutMs = 40_000) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

async function permission(base, token, input) {
  const sessionId = input.session_id;
  const toolName = input.tool_name;
  if (!sessionId || !toolName) return;
  // Запись о вызове может лечь на диск позже старта хука, а файла свежей сессии
  // может ещё не быть: ищем до `FIND_MS`. Ответили в окне раньше — вызов закрыт
  // результатом, не найдётся, и хук выходит без регистрации.
  const until = Date.now() + FIND_MS;
  let toolUseId = findToolUseId(readTail(input.transcript_path), toolName, input.tool_input);
  while (!toolUseId && Date.now() < until) {
    await sleep(FIND_EVERY_MS);
    toolUseId = findToolUseId(readTail(input.transcript_path), toolName, input.tool_input);
  }
  if (!toolUseId) return;

  const registered = await call(base, token, 'POST', '/api/outside/asks', {
    toolUseId,
    sessionId,
    toolName,
    ...(input.cwd ? { cwd: input.cwd } : {}),
    ...(input.tool_input !== undefined ? { input: input.tool_input } : {}),
  });
  if (!registered?.intercept) return;

  const id = encodeURIComponent(toolUseId);
  const release = () =>
    call(base, token, 'POST', `/api/outside/asks/${id}/release`).catch(() => undefined);
  const deadline = Date.now() + MAX_MS;
  let failures = 0;
  while (Date.now() < deadline) {
    let result;
    try {
      result = await call(base, token, 'GET', `/api/outside/asks/${id}/wait?ms=${WAIT_SLICE_MS}`);
      failures = 0;
    } catch {
      // Панель перезапускается — несколько попыток, потом решает только окно.
      if (++failures > NETWORK_RETRIES) return;
      await sleep(RETRY_MS);
      continue;
    }
    if (result?.state === 'pending') {
      // Ответили в окне: CLI уже пошёл дальше, а наш ответ ему не нужен. Карточку
      // на телефоне снимаем, иначе она висела бы до предела ожидания.
      if (hasToolResult(readTail(input.transcript_path), toolUseId)) return void (await release());
      continue;
    }
    const output = permissionOutput(result, input.tool_input ?? {});
    if (output) process.stdout.write(JSON.stringify(output));
    return;
  }
  await release();
}

/**
 * Шаг сессии без сообщения с телефона — на сервер не ходим. Флаг сессии сервер
 * кладёт в `outside-queue` рядом с файлом токена, пока сообщение ждёт; метка
 * `.server` — знак, что сервер флаги пишет (без неё спрашиваем каждый раз).
 * Конец хода спрашивает всегда: раз за ход, и он страхует пропущенный флаг.
 * Правило имени — `relayFlagName` в `outside-relay.ts`.
 */
function nothingQueued(input, tokenFile) {
  if (input.hook_event_name !== 'PostToolUse' || !tokenFile) return false;
  const dir = join(dirname(tokenFile), 'outside-queue');
  const flag = String(input.session_id).replace(/[^a-zA-Z0-9-]/g, '');
  return Boolean(flag) && existsSync(join(dir, '.server')) && !existsSync(join(dir, flag));
}

async function messages(base, token, input) {
  if (!input.session_id) return;
  // Хук стоит на каждом шаге каждой сессии: панель не ответила быстро — шаг не ждёт.
  const taken = await call(
    base,
    token,
    'POST',
    '/api/outside/messages/take',
    // Событие — серверу: конец хода (`Stop`) без сообщений в очереди — повод
    // для «Закончил» в Telegram после долгой работы.
    { sessionId: input.session_id, event: input.hook_event_name },
    2000,
  );
  const output = messagesOutput(input.hook_event_name, taken?.texts ?? []);
  if (output) process.stdout.write(JSON.stringify(output));
}

async function main() {
  const base = arg('--url') ?? 'http://127.0.0.1:5178';
  const tokenFile = arg('--token-file') ?? '';
  const input = JSON.parse((await readStdin()) || '{}');
  if (nothingQueued(input, tokenFile)) return;
  let token = '';
  try {
    token = readFileSync(tokenFile, 'utf8').trim();
  } catch {
    // Без токена панель с включённым шлюзом ответит 401 — и всё решает окно.
  }
  if (input.hook_event_name === 'PermissionRequest') return permission(base, token, input);
  if (input.hook_event_name === 'PostToolUse' || input.hook_event_name === 'Stop') {
    return messages(base, token, input);
  }
}

// Без `process.exit`: на Windows выход при ещё закрывающемся сокете `fetch`
// роняет процесс на проверке libuv с кодом 127 (замер 11.10), а ненулевой код
// CLI считает ошибкой хука и выбрасывает его ответ. Процесс кончается сам.
main()
  .catch(() => undefined)
  .finally(() => {
    process.exitCode = 0;
  });
