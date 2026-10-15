import { spawn, type ChildProcess } from 'node:child_process';
import { freemem } from 'node:os';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { dirname } from 'node:path';
import type { KvCacheType, LocalDevice } from '@agentdeck/contracts/local-models';
import { killChildProcessTree, killProcessTree } from '../../lib/kill-tree.mjs';
import type { FetchLike } from './download.ts';
import { localError } from './errors.ts';
import { launchHidden, pidAlive } from './hidden-launch.ts';
import { llamaClient, type Health } from './llama-client.ts';
import type { LocalPaths } from './paths.ts';

/**
 * Жизнь нашего `llama-server`.
 *
 * Сервер запускается ОТДЕЛЬНО от панели (detached) и записывает себя в
 * `run/llama.json`. Панель в разработке перезапускается `node --watch`, который
 * на Windows убивает её без обработчиков: дочерний процесс без такой записи стал
 * бы сиротой, державшей порт и видеопамять, а новая панель подняла бы второй.
 * С записью новая панель ПОДХВАТЫВАЕТ живой сервер по номеру и порту.
 *
 * У llama-server модель, окно, тип кеша и устройство — аргументы запуска, а не
 * поля запроса: любое изменение — перезапуск (`sameShape`). Остановка — снятие
 * дерева процессов и ожидание закрытия порта; отдельной «выгрузки» нет, модель
 * живёт ровно столько, сколько процесс, и вместе с ним уходит из видеопамяти.
 */

/**
 * Куда класть слои. `all` — всё на карту (`-ngl 999`): подбор уже проверил, что
 * влезает. `fit` — слоёв больше, чем помещается: сервер сам делит модель с
 * процессором (`--fit on`). `none` — счёт на процессоре.
 */
export type Offload = 'all' | 'fit' | 'none';

/** Всё, что определяет запуск; запись о запущенном сервере — это она же плюс номер процесса. */
export interface ServerShape {
  /** Идентификатор модели (имя для запросов, `--alias`). */
  tag: string;
  /** Путь к GGUF. */
  file: string;
  /** Метка квантования, как её видит человек. */
  quant: string;
  context: number;
  kvCache: KvCacheType;
  device: LocalDevice;
  /** Звать с `--spec-type draft-mtp`: слой предсказания в файле есть. */
  mtp: boolean;
  offload: Offload;
  /**
   * Через сколько секунд простоя сервер выгружает модель и кеши (`--sleep-idle-seconds`);
   * нет или 0 — модель держится загруженной. Часть запуска: флаг меняется только перезапуском.
   */
  idleSeconds?: number;
  /**
   * Модель с рекуррентным состоянием (гибрид): сдвиг кеша ей недоступен, и
   * `--cache-reuse` не передаётся. Следствие файла, а не выбора — в сравнении запусков не участвует.
   */
  recurrent?: boolean;
  /** JSON для `--chat-template-kwargs` из каталога (усилие рассуждения); нет — флага нет. */
  templateKwargs?: string;
  /** Полный путь к своему шаблону чата из каталога (`--chat-template-file`); нет — шаблон из GGUF. */
  templateFile?: string;
  /**
   * Тип кеша и раскладку выбрал подбор, а не человек. Пока такой сервер идёт, следующий
   * запуск берёт их из записи, а не подбирает заново: подбор при живом сервере засчитывает
   * его память по оценке, а она с запасом больше настоящей, и второй запуск выбирал q8_0
   * вместо q4_0 — лишний перезапуск на 131072 (L6, «не с первого раза»). В сравнении
   * запусков не участвует.
   */
  fitted?: boolean;
}

export interface ServerRecord extends ServerShape {
  pid: number;
  port: number;
  binary: string;
  startedAt: number;
}

/** Тот же ли запуск: изменение любого поля — другой сервер. */
export function sameShape(record: ServerShape, shape: ServerShape): boolean {
  return (
    record.tag === shape.tag &&
    record.file === shape.file &&
    record.context === shape.context &&
    record.kvCache === shape.kvCache &&
    record.device === shape.device &&
    record.mtp === shape.mtp &&
    record.offload === shape.offload &&
    (record.idleSeconds ?? 0) === (shape.idleSeconds ?? 0) &&
    (record.templateKwargs ?? '') === (shape.templateKwargs ?? '') &&
    (record.templateFile ?? '') === (shape.templateFile ?? '')
  );
}

/**
 * Память под сохранённые состояния промпта в оперативной (`--cache-ram`), МиБ.
 * Умолчание сервера — 8192 при любой свободной памяти: на каждый «возврат к
 * старому промпту» (сжатие истории, второй чат) он кладёт снимок, и у гибридных
 * моделей снимок — сотни мегабайт состояния слоёв. Здесь — четверть свободной
 * памяти на момент запуска, но не больше 8 ГиБ и не меньше гигабайта: человеку
 * оперативная нужна и самому (замер 14.10: 7B и 27B возвращаются в прежний чат за
 * 20–240 мс при любом из двух значений, а выше предела выигрыша нет).
 */
export const PROMPT_CACHE_MAX_MIB = 8192;
export const PROMPT_CACHE_MIN_MIB = 1024;
export function promptCacheMib(freeBytes: number): number {
  const quarter = Math.floor(freeBytes / 1024 ** 2 / 4 / 256) * 256;
  return Math.min(PROMPT_CACHE_MAX_MIB, Math.max(PROMPT_CACHE_MIN_MIB, quarter));
}
/** Контрольные точки состояния на слот (`--ctx-checkpoints`): по ним продолжается разговор без пересчёта всего промпта. */
export const CONTEXT_CHECKPOINTS = 8;
/**
 * Наименьший кусок кеша, который сервер пробует вернуть сдвигом (`--cache-reuse`):
 * после сжатия истории голова промпта другая, а середина прежняя. Замер 14.10
 * (7B, 6364 токена после обрезанной головы): 603 мс → 70 мс, пересчитано 10 токенов
 * вместо 6364. Модели с рекуррентным состоянием сдвиг недоступен.
 */
export const CACHE_REUSE_MIN_CHUNK = 256;
/** Простой, после которого модель выгружается из видеопамяти и оперативной (`--sleep-idle-seconds`). */
export const IDLE_SLEEP_SECONDS = 600;
/** Сколько токенов предсказывает слой MTP за шаг; по умолчанию сервера 3, замер 13.10 — 162 предсказано, 87 принято. */
export const MTP_DRAFT_TOKENS = 3;

/** То, что решается в момент запуска и в сравнение запусков не входит. */
export interface ServerTuning {
  /** `--cache-ram`, МиБ. */
  cacheRamMib: number;
  /** `--slot-save-path`: без каталога сервер не выполняет действия над слотом (сброс кеша). */
  slotSavePath?: string;
}

/** Аргументы `llama-server`; каждый флаг сверен с `--help` сборки из `data/llama-release.json`. */
export function serverArgs(
  shape: ServerShape,
  port: number,
  tuning: ServerTuning = { cacheRamMib: PROMPT_CACHE_MIN_MIB },
): string[] {
  const args = [
    '-m',
    shape.file,
    '--alias',
    shape.tag,
    '--host',
    '127.0.0.1',
    '--port',
    String(port),
    '-c',
    String(shape.context),
  ];
  if (shape.offload === 'all') args.push('-ngl', '999', '--fit', 'off');
  else if (shape.offload === 'none') args.push('-ngl', '0', '--fit', 'off');
  else args.push('--fit', 'on');
  args.push(
    '-fa',
    'on',
    '-ctk',
    shape.kvCache,
    '-ctv',
    shape.kvCache,
    '--jinja',
    '--cache-ram',
    String(tuning.cacheRamMib),
    '--ctx-checkpoints',
    String(CONTEXT_CHECKPOINTS),
    '-np',
    '1',
    '--metrics',
    '--no-webui',
  );
  if (!shape.recurrent) args.push('--cache-reuse', String(CACHE_REUSE_MIN_CHUNK));
  if (tuning.slotSavePath) args.push('--slot-save-path', tuning.slotSavePath);
  if (shape.idleSeconds) args.push('--sleep-idle-seconds', String(shape.idleSeconds));
  if (shape.templateKwargs) args.push('--chat-template-kwargs', shape.templateKwargs);
  if (shape.templateFile) args.push('--chat-template-file', shape.templateFile);
  if (shape.mtp)
    args.push('--spec-type', 'draft-mtp', '--spec-draft-n-max', String(MTP_DRAFT_TOKENS));
  return args;
}

/**
 * Счёт на процессоре: карты прячутся от сервера переменными видимости каждого
 * движка (CUDA, ROCm/HIP, Vulkan). У Metal на Mac такой переменной нет: там
 * модель ляжет в объединённую память всё равно, и экран говорит это, а не верит.
 */
export const CPU_ONLY_ENV: Record<string, string> = {
  CUDA_VISIBLE_DEVICES: '-1',
  HIP_VISIBLE_DEVICES: '-1',
  ROCR_VISIBLE_DEVICES: '-1',
  GGML_VK_VISIBLE_DEVICES: '-1',
};

/**
 * Окружение сервера. Переменные `LLAMA_ARG_*` человека снимаются: любая из них
 * молча подменила бы флаг запуска (у llama.cpp для каждого флага есть своя), и
 * сервер поднялся бы не с тем, что записано в `run/llama.json`.
 */
export function serverEnv(
  device: LocalDevice,
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(base)) {
    if (!key.startsWith('LLAMA_ARG_')) env[key] = value;
  }
  return device === 'cpu' ? { ...env, ...CPU_ONLY_ENV } : env;
}

export function readRecord(paths: LocalPaths): ServerRecord | undefined {
  if (!existsSync(paths.pidFile)) return undefined;
  try {
    const record = JSON.parse(readFileSync(paths.pidFile, 'utf8')) as Partial<ServerRecord>;
    // Запись прежнего сервера (Ollama) лежала в другом файле; здесь любая без модели — чужая.
    return record.pid && record.port && record.file && record.tag
      ? (record as ServerRecord)
      : undefined;
  } catch {
    return undefined;
  }
}

function writeRecord(paths: LocalPaths, record: ServerRecord): void {
  mkdirSync(dirname(paths.pidFile), { recursive: true });
  writeFileSync(paths.pidFile, JSON.stringify(record, null, 2));
}

export function baseUrlOf(port: number): string {
  return `http://127.0.0.1:${port}`;
}

/** Отвечает ли сервер на порту. */
export function probe(port: number, fetchImpl: FetchLike = fetch): Promise<Health | undefined> {
  return llamaClient(baseUrlOf(port), fetchImpl).health();
}

/**
 * Сколько ждать готовности. Модель на 17 ГБ с диска грузится 15–60 с, а на
 * медленном диске или после перезагрузки (холодный кеш файлов) — минуты.
 */
export const START_TIMEOUT_MS = 300_000;

export interface StartInput {
  paths: LocalPaths;
  binary: string;
  port: number;
  shape: ServerShape;
  fetchImpl?: FetchLike;
  /** Подменяемый запуск — проверки поднимают заглушку вместо настоящего llama-server. */
  spawnImpl?: typeof spawn;
  timeoutMs?: number;
  /** Подменяемое снятие процесса — проверки не трогают чужие номера. */
  kill?: (pid: number, startedAt: number) => void;
  /** Свободная оперативная память, байт, — под неё считается `--cache-ram`; проверки подставляют своё. */
  freeBytes?: () => number;
}

/**
 * Журнал прошлого запуска переезжает в `<имя>.prev.log` до нового запуска. Скрытый
 * запуск на Windows пишет журнал заново, и подъём после зависания стирал ровно то,
 * что объясняло зависание (L6, 14.10: 20 минут тишины чата, журнал того часа
 * перезаписан следующим запуском). Хранится один прошлый — не архив, а улика.
 * Не вышло (файл держит чужой процесс) — запуск идёт как раньше.
 */
export function keepPreviousLog(path: string): void {
  try {
    if (!existsSync(path) || statSync(path).size === 0) return;
    renameSync(path, path.replace(/\.log$/, '.prev.log'));
  } catch {
    // Журнал занят живым процессом — новый запуск допишет в него же.
  }
}

/** Строка журнала, похожая на причину падения: ошибка CUDA, нехватка памяти, отказ открыть файл. */
const ERROR_LINE = /error|fail|out of memory|abort|exception|cannot|unable|exceeds/i;
/** Сколько с конца журнала читать: причина — в последних строках, журнал бывает в десятки мегабайт. */
const LOG_TAIL_BYTES = 64 * 1024;

/**
 * Последняя строка, похожая на ошибку, из первого журнала, где она есть: её называет отказ,
 * когда сервер не поднимается раз за разом (L6), вместо «код 1» и пути к журналу. Нет такой
 * строки или журнала — `undefined`.
 */
export function lastErrorLine(logPaths: string[]): string | undefined {
  for (const path of logPaths) {
    let text: string;
    try {
      const size = statSync(path).size;
      const length = Math.min(size, LOG_TAIL_BYTES);
      const buffer = Buffer.alloc(length);
      const fd = openSync(path, 'r');
      try {
        readSync(fd, buffer, 0, length, size - length);
      } finally {
        closeSync(fd);
      }
      text = buffer.toString('utf8');
    } catch {
      continue;
    }
    const hit = text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .reverse()
      .find((line) => line.length > 0 && ERROR_LINE.test(line));
    if (hit) return hit.length > 300 ? `${hit.slice(0, 300)}…` : hit;
  }
  return undefined;
}

interface Launched {
  pid: number;
  /** Код выхода, если процесс уже завершился; жив — null. */
  exited: () => number | null;
}

/**
 * Запустить `llama-server` отдельно от панели. Windows без подменённого запуска —
 * через скрытую консоль (`hidden-launch.ts`); остальное — detached, вывод
 * дописывается в журнал.
 */
async function launch(
  input: StartInput,
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<Launched> {
  const fail = (): never => {
    throw localError('local-start-failed', `не удалось запустить ${input.binary}`, {
      binary: input.binary,
    });
  };
  if (!input.spawnImpl && process.platform === 'win32') {
    const pid = await launchHidden(input.binary, args, env, {
      out: input.paths.serverLog.replace(/\.log$/, '.out.log'),
      err: input.paths.serverLog,
    }).catch(fail);
    return { pid, exited: () => (pidAlive(pid) ? null : -1) };
  }
  const log = openSync(input.paths.serverLog, 'a');
  const child = (input.spawnImpl ?? spawn)(input.binary, args, {
    env,
    detached: true,
    stdio: ['ignore', log, log],
    windowsHide: true,
    // Рядом с исполняемым файлом лежат его библиотеки (`libggml-*.so`, `*.dylib`).
    cwd: dirname(input.binary),
  });
  closeSync(log);
  if (!child.pid) return fail();
  child.unref();
  let code: number | null = null;
  child.once('exit', (exitCode) => {
    code = exitCode ?? -1;
  });
  return { pid: child.pid, exited: () => code };
}

/** Поднять сервер и дождаться готовности. Уже идущий с тем же запуском подхватывается. */
export async function startServer(input: StartInput): Promise<{ record: ServerRecord }> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const already = await probe(input.port, fetchImpl);
  const known = readRecord(input.paths);
  if (already !== undefined) {
    if (known?.port === input.port && sameShape(known, input.shape)) return { record: known };
    throw localError(
      'local-port-busy',
      `порт ${input.port} занят другим сервером — остановите его или освободите порт`,
      { port: input.port },
    );
  }
  mkdirSync(dirname(input.paths.serverLog), { recursive: true });
  mkdirSync(input.paths.slotsDir, { recursive: true });
  keepPreviousLog(input.paths.serverLog);
  keepPreviousLog(input.paths.serverLog.replace(/\.log$/, '.out.log'));
  const launched = await launch(
    input,
    serverArgs(input.shape, input.port, {
      cacheRamMib: promptCacheMib((input.freeBytes ?? freemem)()),
      slotSavePath: input.paths.slotsDir,
    }),
    serverEnv(input.shape.device),
  );
  const record: ServerRecord = {
    ...input.shape,
    pid: launched.pid,
    port: input.port,
    binary: input.binary,
    startedAt: Date.now(),
  };
  writeRecord(input.paths, record);

  const timeoutMs = input.timeoutMs ?? START_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  let exited: number | null = null;
  while (Date.now() < deadline) {
    if ((await probe(input.port, fetchImpl)) === 'ok') return { record };
    exited = launched.exited();
    if (exited !== null) break;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  // Не ответил — снять: иначе процесс без записи держит порт и видеопамять, а
  // следующий запуск натыкается на «порт занят» сиротой, которую панель уже не видит.
  if (exited === null)
    (input.kill ?? ((pid, startedAt) => killProcessTree(pid, { spawnedAt: startedAt })))(
      launched.pid,
      record.startedAt,
    );
  rmSync(input.paths.pidFile, { force: true });
  const logPath = input.paths.serverLog;
  if (exited !== null) {
    throw localError(
      'local-exited',
      `сервер моделей завершился сразу после запуска (код ${exited}) — журнал: ${logPath}`,
      { code: exited, log: logPath },
    );
  }
  const seconds = Math.round(timeoutMs / 1000);
  throw localError(
    'local-timeout',
    `сервер моделей не ответил за ${seconds} с — журнал: ${logPath}`,
    { seconds, log: logPath },
  );
}

/** Снять процесс и дождаться, пока порт закроется. Возвращает модель, которая стояла в памяти. */
export async function stopServer(
  paths: LocalPaths,
  port: number,
  fetchImpl: FetchLike = fetch,
  kill: (pid: number, startedAt: number) => void = (pid, startedAt) => {
    killProcessTree(pid, { spawnedAt: startedAt });
  },
): Promise<{ unloaded: string[] }> {
  const record = readRecord(paths);
  if (record) kill(record.pid, record.startedAt);
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline && (await probe(port, fetchImpl)) !== undefined) {
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if ((await probe(port, fetchImpl)) !== undefined) {
    throw localError('local-stop-failed', `сервер на порту ${port} не остановился`, { port });
  }
  rmSync(paths.pidFile, { force: true });
  return { unloaded: record ? [record.tag] : [] };
}

/** Свободный порт на loopback — для пробной загрузки, чтобы не задеть рабочий сервер. */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

/** Сколько ждать пробной загрузки: холодный диск, 17 ГБ через mmap. */
export const TEST_LOAD_TIMEOUT_MS = 240_000;

/**
 * Пробная загрузка: открывает ли llama.cpp этот GGUF. Только на процессоре
 * (`-ngl 0`, карты спрятаны), с окном 512: проверяется разбор файла и тензоров,
 * а видеопамять не занимается, и рабочий сервер рядом не задевается. Ответил
 * `/health` — файл открылся; процесс вышел раньше — открыть не удалось, и причина
 * берётся из последних строк его журнала.
 */
export async function testLoadModel(input: {
  binary: string;
  file: string;
  timeoutMs?: number;
  fetchImpl?: FetchLike;
  spawnImpl?: typeof spawn;
  kill?: (child: ChildProcess) => void;
}): Promise<{ ok: true } | { ok: false; reason: string }> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const port = await freePort();
  const args = [
    '-m',
    input.file,
    '--host',
    '127.0.0.1',
    '--port',
    String(port),
    '-c',
    '512',
    '-ngl',
    '0',
    '--fit',
    'off',
    '-np',
    '1',
    '--no-warmup',
    '--no-webui',
  ];
  const child = (input.spawnImpl ?? spawn)(input.binary, args, {
    env: serverEnv('cpu'),
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    cwd: dirname(input.binary),
  });
  let tail = '';
  const collect = (chunk: Buffer): void => {
    tail = (tail + String(chunk)).slice(-4000);
  };
  child.stdout?.on('data', collect);
  child.stderr?.on('data', collect);
  let code: number | null = null;
  child.once('exit', (exitCode) => {
    code = exitCode ?? -1;
  });
  const client = llamaClient(baseUrlOf(port), fetchImpl);
  const deadline = Date.now() + (input.timeoutMs ?? TEST_LOAD_TIMEOUT_MS);
  try {
    while (Date.now() < deadline) {
      if ((await client.health()) === 'ok') return { ok: true };
      if (code !== null) break;
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
    const lines = tail
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    const reason =
      lines.filter((line) => /error|failed|unknown|unsupported/i.test(line)).pop() ??
      lines.pop() ??
      (code === null ? 'timeout' : `exit code ${code}`);
    return { ok: false, reason: reason.slice(0, 300) };
  } finally {
    if (code === null) (input.kill ?? killChildProcessTree)(child);
  }
}
