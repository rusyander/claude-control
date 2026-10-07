import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
  closeSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { killProcessTree } from '../../lib/kill-tree.mjs';
import { localError } from './errors.ts';
import { ollamaClient, type FetchLike } from './ollama-client.ts';
import type { LocalPaths } from './paths.ts';

/**
 * Жизнь нашего сервера моделей.
 *
 * Сервер запускается ОТДЕЛЬНО от панели (detached) и записывает себя в
 * `run/ollama.json`. Панель в разработке перезапускается `node --watch`, который
 * на Windows убивает её без обработчиков: дочерний процесс без такой записи стал
 * бы сиротой, державшей порт и видеопамять, а новая панель подняла бы второй.
 * С записью новая панель ПОДХВАТЫВАЕТ живой сервер по номеру и порту.
 *
 * Остановка — в том порядке, который освобождает видеопамять на деле: сперва
 * выгрузить каждую загруженную модель, потом снять дерево процессов, потом
 * убедиться, что порт закрыт. Снять сервер первым — значит оставить сиротой
 * процесс-исполнитель модели вместе с её гигабайтами.
 */

export interface ServerRecord {
  pid: number;
  port: number;
  binary: string;
  context: number;
  startedAt: number;
}

export interface ServerEnvInput {
  paths: LocalPaths;
  port: number;
  context: number;
  base?: NodeJS.ProcessEnv;
}

/** Окружение сервера: всё, что раньше человек прописывал руками. */
export function serverEnv(input: ServerEnvInput): NodeJS.ProcessEnv {
  return {
    ...(input.base ?? process.env),
    OLLAMA_HOST: `127.0.0.1:${input.port}`,
    OLLAMA_MODELS: input.paths.models,
    // Контекст на весь сервер: Claude Code по Anthropic API не умеет передать
    // `num_ctx` в запросе, а умолчание Ollama на картах до 24 ГБ — 4096 токенов,
    // меньше одного системного промпта агента.
    OLLAMA_CONTEXT_LENGTH: String(input.context),
    OLLAMA_FLASH_ATTENTION: '1',
    // Кеш контекста в q8_0 — вдвое меньше памяти при неотличимом качестве.
    OLLAMA_KV_CACHE_TYPE: 'q8_0',
    // Простаивающая модель уходит из видеопамяти сама: машина владельца — не
    // сервер, ей нужна карта для остального.
    OLLAMA_KEEP_ALIVE: '10m',
    OLLAMA_NUM_PARALLEL: '1',
    OLLAMA_MAX_LOADED_MODELS: '1',
    // Без чистки слоёв при старте: недокачанная модель докачивается с места и
    // после перезапуска сервера, а не заново с нуля.
    OLLAMA_NOPRUNE: '1',
  };
}

export function readRecord(paths: LocalPaths): ServerRecord | undefined {
  if (!existsSync(paths.pidFile)) return undefined;
  try {
    return JSON.parse(readFileSync(paths.pidFile, 'utf8')) as ServerRecord;
  } catch {
    return undefined;
  }
}

function writeRecord(paths: LocalPaths, record: ServerRecord): void {
  mkdirSync(dirname(paths.pidFile), { recursive: true });
  writeFileSync(paths.pidFile, JSON.stringify(record));
}

export function baseUrlOf(port: number): string {
  return `http://127.0.0.1:${port}`;
}

/** Отвечает ли сервер на порту — и его ли это версия ответа. */
export async function probe(
  port: number,
  fetchImpl: FetchLike = fetch,
): Promise<string | undefined> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1500);
    try {
      const response = await fetchImpl(`${baseUrlOf(port)}/api/version`, {
        signal: controller.signal,
      });
      if (!response.ok) return undefined;
      return ((await response.json()) as { version?: string }).version ?? '';
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return undefined;
  }
}

export interface StartInput {
  paths: LocalPaths;
  binary: string;
  port: number;
  context: number;
  fetchImpl?: FetchLike;
  /** Подменяемый запуск — проверки поднимают заглушку вместо настоящего Ollama. */
  spawnImpl?: typeof spawn;
  timeoutMs?: number;
}

/** Поднять сервер и дождаться ответа. Возвращает версию. */
export async function startServer(
  input: StartInput,
): Promise<{ version: string; record: ServerRecord }> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const already = await probe(input.port, fetchImpl);
  const known = readRecord(input.paths);
  if (already !== undefined) {
    if (known?.port === input.port) return { version: already, record: known };
    throw localError(
      'local-port-busy',
      `порт ${input.port} занят другим сервером — остановите его или освободите порт`,
      { port: input.port },
    );
  }
  mkdirSync(dirname(input.paths.serverLog), { recursive: true });
  const log = openSync(input.paths.serverLog, 'a');
  const child = (input.spawnImpl ?? spawn)(input.binary, ['serve'], {
    env: serverEnv({ paths: input.paths, port: input.port, context: input.context }),
    detached: true,
    stdio: ['ignore', log, log],
    windowsHide: true,
  });
  closeSync(log);
  if (!child.pid)
    throw localError('local-start-failed', `не удалось запустить ${input.binary}`, {
      binary: input.binary,
    });
  child.unref();
  const record: ServerRecord = {
    pid: child.pid,
    port: input.port,
    binary: input.binary,
    context: input.context,
    startedAt: Date.now(),
  };
  writeRecord(input.paths, record);

  let exited: number | null = null;
  child.once('exit', (code) => {
    exited = code ?? -1;
  });
  const deadline = Date.now() + (input.timeoutMs ?? 30_000);
  while (Date.now() < deadline) {
    const version = await probe(input.port, fetchImpl);
    if (version !== undefined) return { version, record };
    if (exited !== null) break;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  rmSync(input.paths.pidFile, { force: true });
  const logPath = input.paths.serverLog;
  if (exited !== null) {
    throw localError(
      'local-exited',
      `сервер моделей завершился сразу после запуска (код ${exited}) — журнал: ${logPath}`,
      { code: exited, log: logPath },
    );
  }
  const seconds = Math.round((input.timeoutMs ?? 30_000) / 1000);
  throw localError(
    'local-timeout',
    `сервер моделей не ответил за ${seconds} с — журнал: ${logPath}`,
    {
      seconds,
      log: logPath,
    },
  );
}

/** Выгрузить модели, снять процесс, дождаться закрытия порта. */
export async function stopServer(
  paths: LocalPaths,
  port: number,
  fetchImpl: FetchLike = fetch,
  kill: (pid: number, startedAt: number) => void = (pid, startedAt) => {
    killProcessTree(pid, { spawnedAt: startedAt });
  },
): Promise<{ unloaded: string[] }> {
  const record = readRecord(paths);
  const unloaded: string[] = [];
  if ((await probe(port, fetchImpl)) !== undefined) {
    const client = ollamaClient(baseUrlOf(port), fetchImpl);
    try {
      for (const model of await client.ps()) {
        await client.unload(model.name);
        unloaded.push(model.name);
      }
    } catch {
      // Выгрузка не удалась — снятие процесса всё равно вернёт память.
    }
  }
  if (record) kill(record.pid, record.startedAt);
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline && (await probe(port, fetchImpl)) !== undefined) {
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if ((await probe(port, fetchImpl)) !== undefined) {
    throw localError('local-stop-failed', `сервер на порту ${port} не остановился`, { port });
  }
  rmSync(paths.pidFile, { force: true });
  return { unloaded };
}
