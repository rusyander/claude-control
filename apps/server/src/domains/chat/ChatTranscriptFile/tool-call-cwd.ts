import { readdirSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import type { Record } from '../ChatRecords/ChatRecords.ts';
import { findTranscript, readAllRecords, readTailRecords } from './ChatTranscriptFile.ts';

/**
 * Каталог оболочки CLI в момент вызова инструмента — по транскрипту (N4, 23.10).
 *
 * Запрос прав каталога не несёт, а оболочка Bash у CLI хранит его между
 * вызовами: после `cd inst-docs-ui` прошлой командой `../.agent/tmp/x` судился
 * от корня копии и уходил «из копии» — карточка человеку на уборку своего.
 * CLI пишет `cwd` в каждую запись транскрипта; запись с вызовом ложится раньше
 * запроса прав (живой журнал: запись 08:18:45.917, запрос 08:18:46.568).
 *
 * Берётся свежайший `cwd` начиная с записи, где этот вызов: результаты
 * соседних вызовов того же ответа, исполненных раньше, несут каталог уже после
 * них. Вызова в хвосте нет (субагент пишет свой файл, запись не успела) или
 * соседний вызов раньше ещё не дописан — `undefined`, и разбор судит от корня
 * копии, как раньше.
 */

/** Хвост, в котором ищется вызов: он в последнем ответе, но тело вызова бывает большим. */
const CALL_TAIL_BYTES = 512 * 1024;

function carriesCall(record: Record, toolUseId: string): boolean {
  const content = record.message?.content;
  return (
    record.type === 'assistant' &&
    Array.isArray(content) &&
    content.some((block) => block.type === 'tool_use' && block.id === toolUseId)
  );
}

const callIdsOf = (record: Record): string[] => {
  const content = record.message?.content;
  if (record.type !== 'assistant' || !Array.isArray(content)) return [];
  return content.flatMap((block) => (block.type === 'tool_use' && block.id ? [block.id] : []));
};

const resultIdsOf = (record: Record): string[] => {
  const content = record.message?.content;
  if (!Array.isArray(content)) return [];
  return content.flatMap((block) =>
    block.type === 'tool_result' && block.tool_use_id ? [block.tool_use_id] : [],
  );
};

/**
 * Вызовы того же ответа раньше этого ещё без результата в файле: каталог после
 * них неизвестен. `cd ..` соседним вызовом и `rm -rf ../src` этим — по записи
 * вызова каталог был бы подкаталогом, а оболочка уже в корне, и удаление вне
 * копии прошло бы как своё.
 */
function siblingsPending(records: readonly Record[], at: number, sidechain: boolean): boolean {
  const turn = records[at]?.message?.id;
  if (!turn) return false;
  const earlier = records
    .slice(0, at)
    .filter((record) => !!record.isSidechain === sidechain && record.message?.id === turn)
    .flatMap(callIdsOf);
  if (earlier.length === 0) return false;
  const done = new Set(records.slice(at).flatMap(resultIdsOf));
  return earlier.some((id) => !done.has(id));
}

/** Итог поиска: `found: false` — записи вызова в прочитанном ещё нет. */
interface CallLookup {
  found: boolean;
  cwd?: string;
}

/**
 * `sidechain` — чьи записи читать: файл субагента целиком из записей
 * `isSidechain`, а в файле разговора они чужие (старый формат клал их туда же).
 */
function lookupIn(records: readonly Record[], toolUseId: string, sidechain = false): CallLookup {
  const own = (record: Record): boolean => !!record.isSidechain === sidechain;
  const at = records.findIndex((record) => own(record) && carriesCall(record, toolUseId));
  if (at < 0) return { found: false };
  if (siblingsPending(records, at, sidechain)) return { found: true };
  let cwd: string | undefined;
  for (const record of records.slice(at)) {
    if (!own(record)) continue;
    // Результат этого вызова — предел, сам он уже несёт каталог ПОСЛЕ команды
    // (D-9, 25.10): при пересуде после перезапуска за вызовом идут часы работы
    // группы, и `cd` позже вызова сдвигал его каталог.
    if (resultIdsOf(record).includes(toolUseId)) break;
    if (typeof record.cwd === 'string' && record.cwd) cwd = record.cwd;
  }
  return cwd ? { found: true, cwd } : { found: true };
}

/** Свежайший `cwd` с записи вызова до конца — по уже прочитанным записям. */
export function callCwdIn(records: readonly Record[], toolUseId: string): string | undefined {
  return lookupIn(records, toolUseId).cwd;
}

/**
 * Рабочая папка CLI этой сессии: `<TEMP>/claude/<проект>/<сессия>/scratchpad`
 * (F-77: удаление в ней — уборка своего). Имя проекта CLI выводит из каталога
 * запуска так же, как имя папки транскрипта, — оно и берётся у найденного
 * транскрипта, а не пересчитывается (регистр буквы диска, разделители).
 * TEMP — тот же, что у панели: CLI запущен ею и наследует окружение.
 * Транскрипта нет или имя сессии чужого вида — `undefined`: своей папки нет.
 */
export function sessionScratchpad(
  projectsDir: string,
  sessionId: string | undefined,
  temp: string = tmpdir(),
): string | undefined {
  if (!sessionId || !/^[A-Za-z0-9-]+$/.test(sessionId)) return undefined;
  try {
    const file = findTranscript(projectsDir, sessionId);
    return file
      ? join(temp, 'claude', basename(dirname(file)), sessionId, 'scratchpad')
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Каталог транскриптов, где лежит разговор `sessionId`: у группы это все её
 * разговоры в копии (продолжения, доставка) — по ним суд узнаёт команды, которыми
 * группа заводила процессы (`group-process-owner.ts`, D-1).
 */
export function sessionTranscriptDir(
  projectsDir: string,
  sessionId: string | undefined,
): string | undefined {
  if (!sessionId || !/^[A-Za-z0-9-]+$/.test(sessionId)) return undefined;
  try {
    const file = findTranscript(projectsDir, sessionId);
    return file ? dirname(file) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Сколько свежайших файлов субагентов смотреть хвостом у живого запроса: вызов
 * субагента дописан в его файл перед запросом прав, и этот файл — среди
 * последних тронутых.
 */
const SUBAGENT_TAIL_FILES = 6;

/**
 * Файлы субагентов разговора, свежайшие первыми: `<проект>/<сессия>/subagents/*.jsonl`.
 * Раньше вызов субагента искался только в файле разговора и не находился никогда:
 * каждый его запрос прав ждал 1,3 с и судился от угаданного корня (26.10).
 */
function subagentFiles(main: string, sessionId: string): string[] {
  const dir = join(dirname(main), sessionId, 'subagents');
  try {
    return readdirSync(dir)
      .filter((name) => name.endsWith('.jsonl'))
      .map((name) => {
        const file = join(dir, name);
        return { file, at: statSync(file).mtimeMs };
      })
      .sort((a, b) => b.at - a.at)
      .map((entry) => entry.file);
  } catch {
    return [];
  }
}

/** Где записан вызов: файл разговора или субагента и его прочитанные записи. */
interface CallSite {
  file: string;
  records: Record[];
  sidechain: boolean;
}

/**
 * Файл с записью вызова. `whole: false` — хвосты файла разговора и свежайших
 * субагентов (живой запрос); `true` — файлы целиком, субагенты все (пересуд).
 */
function findCallSite(
  main: string,
  sessionId: string,
  toolUseId: string,
  whole: boolean,
): CallSite | undefined {
  const read = (file: string): Record[] =>
    whole ? readAllRecords(file) : readTailRecords(file, CALL_TAIL_BYTES);
  const carries = (records: readonly Record[], sidechain: boolean): boolean =>
    records.some((record) => !!record.isSidechain === sidechain && carriesCall(record, toolUseId));
  const records = read(main);
  if (carries(records, false)) return { file: main, records, sidechain: false };
  const subagents = subagentFiles(main, sessionId);
  for (const file of whole ? subagents : subagents.slice(0, SUBAGENT_TAIL_FILES)) {
    if (whole && !readFileSync(file, 'utf8').includes(toolUseId)) continue;
    const sub = read(file);
    if (carries(sub, true)) return { file, records: sub, sidechain: true };
  }
  return undefined;
}

const validSession = (sessionId: string | undefined): sessionId is string =>
  !!sessionId && /^[A-Za-z0-9-]+$/.test(sessionId);

/** `found: false` только у найденного файла без записи вызова — её стоит подождать. */
function lookupCall(
  projectsDir: string,
  sessionId: string | undefined,
  toolUseId: string | undefined,
  whole = false,
): CallLookup {
  if (!validSession(sessionId) || !toolUseId) return { found: true };
  try {
    const main = findTranscript(projectsDir, sessionId);
    if (!main) return { found: true };
    const site = findCallSite(main, sessionId, toolUseId, whole);
    return site ? lookupIn(site.records, toolUseId, site.sidechain) : { found: false };
  } catch {
    // Файл переименован или занят — решаем, как без каталога.
    return { found: true };
  }
}

/**
 * Файл транскрипта, где записан вызов `toolUseId`: разговор или его субагент
 * (`own-temp-evidence.ts` читает в нём прошлые вызовы того же агента). Хвосты,
 * затем файлы целиком; `undefined` — вызова нигде нет.
 */
export function callTranscriptFile(
  projectsDir: string,
  sessionId: string | undefined,
  toolUseId: string | undefined,
): string | undefined {
  if (!validSession(sessionId) || !toolUseId) return undefined;
  try {
    const main = findTranscript(projectsDir, sessionId);
    if (!main) return undefined;
    return (
      findCallSite(main, sessionId, toolUseId, false)?.file ??
      findCallSite(main, sessionId, toolUseId, true)?.file
    );
  } catch {
    return undefined;
  }
}

/** Каталог оболочки для вызова `toolUseId` разговора `sessionId`; `undefined` — не узнать. */
export function toolCallCwd(
  projectsDir: string,
  sessionId: string | undefined,
  toolUseId: string | undefined,
): string | undefined {
  return lookupCall(projectsDir, sessionId, toolUseId).cwd;
}

/** Файл разговора `sessionId` (`<проект>/<сессия>.jsonl`); `undefined` — нет его. */
export function sessionTranscriptFile(
  projectsDir: string,
  sessionId: string | undefined,
): string | undefined {
  if (!sessionId || !/^[A-Za-z0-9-]+$/.test(sessionId)) return undefined;
  try {
    return findTranscript(projectsDir, sessionId);
  } catch {
    return undefined;
  }
}

/**
 * То же для пересуда ждущей записи при старте панели (D-9, 25.10): запрос ждал
 * часами, и запись вызова ушла из хвоста (группа дописала мегабайты) — каталог
 * не находился, путь судился от угаданного корня. Нет вызова в хвосте — файл
 * читается целиком: пересуд редок, ожидание записи ему не нужно.
 */
export function recordedToolCallCwd(
  projectsDir: string,
  sessionId: string | undefined,
  toolUseId: string | undefined,
): string | undefined {
  const tail = lookupCall(projectsDir, sessionId, toolUseId);
  if (tail.found) return tail.cwd;
  return lookupCall(projectsDir, sessionId, toolUseId, true).cwd;
}

/**
 * Паузы между повторными чтениями, мс: сумма 1,3 с — предел ожидания записи вызова.
 * D-6 25.10: запись легла 22:04:43.662, запрос прав — 22:04:44.191; бывает и позже.
 */
const CALL_RECORD_PAUSES: readonly number[] = [100, 150, 200, 250, 300, 300];

export interface CallRecordWait {
  /** Пауза перед повторным чтением — подменяема в тесте (часы). */
  sleep?: (ms: number) => Promise<void>;
}

const pause = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

/**
 * То же для живого запроса прав (D-6, 25.10): запрос может прийти раньше, чем CLI
 * допишет запись вызова, — тогда каталога нет, корень копии угадан и `git -C ..`
 * из подпапки уходил «над копию» человеку. Записи вызова нет в найденном файле —
 * чтение повторяется короткими шагами в пределе ~1,3 с. Соседний вызов без
 * результата не ждут: его результат ляжет только после исполнения, а он ждёт
 * этого же решения. Разговора нет — ждать нечего.
 */
export async function settledToolCallCwd(
  projectsDir: string,
  sessionId: string | undefined,
  toolUseId: string | undefined,
  wait: CallRecordWait = {},
): Promise<string | undefined> {
  const sleep = wait.sleep ?? pause;
  let lookup = lookupCall(projectsDir, sessionId, toolUseId);
  for (const ms of CALL_RECORD_PAUSES) {
    if (lookup.found) break;
    await sleep(ms);
    lookup = lookupCall(projectsDir, sessionId, toolUseId);
  }
  return lookup.cwd;
}
