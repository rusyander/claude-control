import { freemem } from 'node:os';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';
import {
  LOCAL_IDLE_MINUTES_DEFAULT,
  type KvCacheType,
  type LocalDevice,
} from '@agentdeck/contracts/local-models';
import { killProcessTree } from '../../lib/kill-tree.mjs';
import type { CoreHold } from './core-hold.ts';
import type { FetchLike } from './download.ts';
import { localError } from './errors.ts';
import { llamaClient, type Health } from './llama-client.ts';
import type { LocalPaths } from './paths.ts';

/**
 * Жизнь нашего `llama-server` — через удержание в ядре.
 *
 * Процесс сервера запускает и держит ядро (`/v1/local/hold`): слот карты, сверка памяти,
 * переживание перезапуска панели — его забота. Панель описывает запуск (флаги → строки
 * пресета), ждёт ответа постоянного адреса ядра (`LOCAL_FRONT_PORT`) и пишет зеркало
 * `run/llama.json` — по нему экран, присмотр и подбор узнают, что и как запущено.
 *
 * У llama-server модель, окно, тип кеша и устройство — аргументы запуска, а не
 * поля запроса: любое изменение — новое удержание (`sameShape`). Остановка — освобождение
 * удержания: ядро снимает сервер и сверяет, что память карты вернулась.
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
   * Отпечаток содержимого шаблона (`templateHashOf`): путь тот же, а шаблон обновился с
   * панелью — сервер держит прежний, пока его не перезапустят. Нет — запуск без отпечатка.
   */
  templateHash?: string;
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
    (record.templateFile ?? '') === (shape.templateFile ?? '') &&
    (record.templateHash ?? '') === (shape.templateHash ?? '')
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
/**
 * Простой по умолчанию, после которого модель выгружается из видеопамяти и оперативной
 * (`--sleep-idle-seconds`); человек выбирает 5, 15 или 60 минут. Пять минут, а не десять: так
 * выбрано, пока панель писала кеш слота на диск перед сном (L8, замер 15.10: запись сервер считал
 * работой и отсчитывал простой заново). Записи перед сном больше нет — кеш пишет ядро при смене
 * разговора (`apps/core/src/platform/slot-cache.ts`), — а пять минут остались выбором по умолчанию.
 */
export const IDLE_SLEEP_SECONDS = LOCAL_IDLE_MINUTES_DEFAULT * 60;
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
 * Окружение, которое запуск задаёт сам поверх окружения ядра: на процессоре — спрятанные карты.
 * Переменные `LLAMA_ARG_*` человека до сервера не доходят: ядро передаёт ему только свой список
 * служебных переменных (`helperEnv`), а не всё окружение.
 */
export function serverEnv(device: LocalDevice): Record<string, string> {
  return device === 'cpu' ? { ...CPU_ONLY_ENV } : {};
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
 * Сколько ждать готовности постоянного адреса после удержания. Ядро возвращает удержание, когда
 * модель уже загружена; ожидание — запас на первую пробу через его порт.
 */
export const START_TIMEOUT_MS = 300_000;

/**
 * Флаги экземпляра, которые в пресет маршрутизатора не идут: файл и имя модели — сама секция
 * пресета, адрес и порт — у маршрутизатора ядра, веб-интерфейс он выключает сам, а Jinja и так
 * включён по умолчанию, `/metrics` разделу не нужен.
 */
const ROUTER_OWNED = new Set([
  '-m',
  '--alias',
  '--host',
  '--port',
  '--no-webui',
  '--jinja',
  '--metrics',
]);

/** Длинное имя флага `llama-server --help` — ключ строки пресета (`ctx-size = 65536`). */
export const PRESET_KEY_OF: Readonly<Record<string, string>> = {
  '-c': 'ctx-size',
  '-ngl': 'n-gpu-layers',
  '-fa': 'flash-attn',
  '-ctk': 'cache-type-k',
  '-ctv': 'cache-type-v',
  '-np': 'parallel',
};

/**
 * Аргументы экземпляра модели строками пресета маршрутизатора ядра: те же флаги, что
 * `serverArgs` (их проверки остаются в силе), длинными именами без дефисов. Флаг без значения
 * в нашем наборе не остаётся: все такие — дело маршрутизатора (`ROUTER_OWNED`).
 */
export function presetArgsOf(flags: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let at = 0; at < flags.length; at += 1) {
    const flag = flags[at] ?? '';
    if (ROUTER_OWNED.has(flag)) {
      // У `-m`, `--alias`, `--host`, `--port` есть значение — оно уходит вместе с флагом.
      if (!['--no-webui', '--jinja', '--metrics'].includes(flag)) at += 1;
      continue;
    }
    const value = flags[at + 1];
    if (value === undefined || value.startsWith('--'))
      throw new Error(`flag ${flag} has no value — a preset line needs one`);
    out[PRESET_KEY_OF[flag] ?? flag.replace(/^-+/, '')] = value;
    at += 1;
  }
  return out;
}

/** Строка журнала, похожая на причину падения: ошибка CUDA, нехватка памяти, отказ открыть файл. */
const ERROR_LINE = /error|fail|out of memory|abort|exception|cannot|unable|exceeds/i;
/** Сколько с конца журнала читать: причина — в последних строках, журнал бывает в десятки мегабайт. */
const LOG_TAIL_BYTES = 64 * 1024;

/**
 * Последняя строка, похожая на ошибку, из первого журнала, где она есть: её называет отказ,
 * когда сервер не поднимается раз за разом (L6), вместо «код 1». Нет такой строки или
 * журнала — `undefined`.
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

/** Отказ ядра плюс строка журнала сервера: человек видит нехватку памяти, а не «загрузка упала». */
function withLogCause(error: unknown, line: string | undefined): unknown {
  if (!line || !(error instanceof Error)) return error;
  const coded = error as Error & { messageCode?: string; params?: Record<string, unknown> };
  if (coded.messageCode !== 'local-hold-refused') return error;
  const code = String(coded.params?.code ?? '');
  const reason = `${String(coded.params?.reason ?? '')} — ${line}`;
  return localError('local-hold-refused', `ядро отказало (${code}): ${reason}`, { code, reason });
}

export interface HoldInput {
  paths: LocalPaths;
  binary: string;
  /** Постоянный порт ядра: на него смотрят проба здоровья, клиент и CLI человека. */
  port: number;
  shape: ServerShape;
  /** Размер файла модели, байт: ядро судит по нему память карты, если раскладки нет. */
  sizeBytes: number;
  /**
   * Сколько памяти карты требует запуск по раскладке панели, байт; 0 — сервер раскладывает
   * слои сам (`--fit on`) или считает на процессоре.
   */
  needBytes: number;
  hold: CoreHold;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  /** Свободная оперативная память, байт, — под неё считается `--cache-ram`; проверки подставляют своё. */
  freeBytes?: () => number;
  /** Снятие прежнего сервера панели (`retireLegacyServer`); проверки подставляют своё. */
  kill?: KillServer;
  /** Замер скорости разбора промпта, ток/с: ядро считает по нему срок первого байта. */
  promptTokensPerSecond?: number;
}

/**
 * Поднять модель удержанием в ядре и дождаться ответа постоянного адреса. Тот же запуск ядро не
 * перезагружает; другой — освобождает прежний (память карты сверяется) и грузит новый. Запись
 * `run/llama.json` — зеркало удержания для страницы и присмотра: порт постоянный, номер процесса —
 * сервера ядра. Прежний сервер панели (до перехода на ядро) снимается до удержания: он держит и
 * порт, и память карты.
 */
export async function holdServer(input: HoldInput): Promise<{ record: ServerRecord }> {
  const fetchImpl = input.fetchImpl ?? fetch;
  await retireLegacyServer(input.paths, input.hold, input.kill);
  mkdirSync(input.paths.slotsDir, { recursive: true });
  const flags = serverArgs(input.shape, input.port, {
    cacheRamMib: promptCacheMib((input.freeBytes ?? freemem)()),
    slotSavePath: input.paths.slotsDir,
  });
  const env = serverEnv(input.shape.device);
  // Журнал этого запуска — свежий: строка прошлого запуска не выдаётся за причину нового.
  // Занят (Windows держит открытый файл) — останется прежний, его перепишет сам сервер.
  try {
    rmSync(input.paths.serverLog, { force: true });
  } catch {
    /* журнал держит живой сервер */
  }
  mkdirSync(dirname(input.paths.serverLog), { recursive: true });
  let view: Awaited<ReturnType<CoreHold['hold']>>;
  try {
    view = await input.hold.hold({
      server: { command: input.binary, ...(Object.keys(env).length > 0 ? { env } : {}) },
      model: {
        id: input.shape.tag,
        path: input.shape.file,
        sizeBytes: Math.max(1, input.sizeBytes),
        contextTokens: input.shape.context,
        needBytes: input.needBytes,
        // Ядро вывод сервера не хранит; журнал модели пишет сам сервер — из него отказ берёт
        // причину (нехватка памяти CUDA), а не «код 1».
        args: { ...presetArgsOf(flags), 'log-file': input.paths.serverLog },
      },
      meta: {
        quant: input.shape.quant,
        ...(input.promptTokensPerSecond
          ? { promptTokensPerSecond: input.promptTokensPerSecond }
          : {}),
      },
    });
  } catch (error) {
    // Новое удержание сначала освобождает прежнее: ядро ничего не держит — зеркало прежнего
    // сервера стирается, иначе экран и удаление считали бы мёртвый сервер живым (ревью m4).
    // Ядро недоступно — судить нечем, зеркало остаётся.
    const after = await input.hold.view().catch(() => undefined);
    if (after && !after.held) rmSync(input.paths.pidFile, { force: true });
    throw withLogCause(error, lastErrorLine([input.paths.serverLog]));
  }
  const record: ServerRecord = {
    ...input.shape,
    pid: view.held?.pid ?? 0,
    port: input.port,
    binary: input.binary,
    startedAt: view.held ? Date.parse(view.held.since) : Date.now(),
  };
  writeRecord(input.paths, record);
  const timeoutMs = input.timeoutMs ?? START_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await probe(input.port, fetchImpl)) === 'ok' && (await frontIsCore(input))) {
      return { record };
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  // Ядро удержало, а постоянный адрес молчит (ядро без адреса, порт держит чужой): удержание
  // снимается — иначе модель держала бы карту, до которой никто не дойдёт.
  await input.hold.release().catch(() => undefined);
  rmSync(input.paths.pidFile, { force: true });
  const seconds = Math.round(timeoutMs / 1000);
  throw localError(
    'local-timeout',
    `модель удержана, но порт ${input.port} не ответил за ${seconds} с`,
    { seconds, log: `port ${input.port}` },
  );
}

/**
 * Порт отвечает голосом ядра, а не чужого сервера: проба здоровья одна не отличит адрес ядра от
 * прежнего llama-server, который порт ещё держит, — кнопка сказала бы «запущено», а CLI говорил
 * бы со старой моделью. Вид ядра без адреса (`front: null`) — судить нечем, решает проба.
 */
async function frontIsCore(input: HoldInput): Promise<boolean> {
  const view = await input.hold.view().catch(() => undefined);
  if (!view?.front) return view !== undefined;
  return view.front.listening && view.front.port === input.port;
}

/** Снять дерево процесса, только если это тот самый процесс (время запуска сходится). */
export type KillServer = (pid: number, startedAt: number) => void;
const killServerTree: KillServer = (pid, startedAt) => {
  killProcessTree(pid, { spawnedAt: startedAt });
};

/**
 * Сервер, поднятый ещё панелью до перехода на ядро: запись `run/llama.json` есть, а ядро держит
 * не его (другой номер процесса или ничего). Он держит постоянный порт — адрес ядра его ждёт и не
 * поднимется — и память карты — ядро откажет новой модели. Снимается деревом с проверкой времени
 * запуска (номер, доставшийся чужому процессу, не трогается) перед удержанием и перед остановкой.
 * Ядро недоступно — судить нечем, ничего не снимается.
 */
export async function retireLegacyServer(
  paths: LocalPaths,
  hold: CoreHold,
  kill: KillServer = killServerTree,
): Promise<boolean> {
  const record = readRecord(paths);
  if (!record) return false;
  const view = await hold.view().catch(() => undefined);
  if (!view || view.held?.pid === record.pid) return false;
  kill(record.pid, record.startedAt);
  // Ядро ничего не держит — запись принадлежала только прежнему серверу.
  if (!view.held) rmSync(paths.pidFile, { force: true });
  return true;
}

/**
 * Освободить удержание в ядре: сервер снят, память карты сверена. Утечка (память не вернулась)
 * — отказ: модель в карте осталась, и кнопка не говорит «остановлено».
 */
export async function releaseServer(
  paths: LocalPaths,
  port: number,
  hold: CoreHold,
  kill: KillServer = killServerTree,
): Promise<{ unloaded: string[] }> {
  const record = readRecord(paths);
  await retireLegacyServer(paths, hold, kill);
  const reply = await hold.release();
  if (reply.leaks.length > 0) {
    throw localError(
      'local-stop-failed',
      `сервер на порту ${port} не остановился: ${reply.leaks.map((leak) => leak.reason).join('; ')}`,
      { port },
    );
  }
  rmSync(paths.pidFile, { force: true });
  return { unloaded: record ? [record.tag] : [] };
}
