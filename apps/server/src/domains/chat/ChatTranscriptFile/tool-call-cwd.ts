import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import type { Record } from '../ChatRecords/ChatRecords.ts';
import { findTranscript, readTailRecords } from './ChatTranscriptFile.ts';

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
function siblingsPending(records: readonly Record[], at: number): boolean {
  const turn = records[at]?.message?.id;
  if (!turn) return false;
  const earlier = records
    .slice(0, at)
    .filter((record) => !record.isSidechain && record.message?.id === turn)
    .flatMap(callIdsOf);
  if (earlier.length === 0) return false;
  const done = new Set(records.slice(at).flatMap(resultIdsOf));
  return earlier.some((id) => !done.has(id));
}

/** Свежайший `cwd` с записи вызова до конца — по уже прочитанным записям. */
export function callCwdIn(records: readonly Record[], toolUseId: string): string | undefined {
  const at = records.findIndex((record) => !record.isSidechain && carriesCall(record, toolUseId));
  if (at < 0 || siblingsPending(records, at)) return undefined;
  let cwd: string | undefined;
  for (const record of records.slice(at)) {
    if (!record.isSidechain && typeof record.cwd === 'string' && record.cwd) cwd = record.cwd;
  }
  return cwd;
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

/** Каталог оболочки для вызова `toolUseId` разговора `sessionId`; `undefined` — не узнать. */
export function toolCallCwd(
  projectsDir: string,
  sessionId: string | undefined,
  toolUseId: string | undefined,
): string | undefined {
  if (!sessionId || !toolUseId || !/^[A-Za-z0-9-]+$/.test(sessionId)) return undefined;
  try {
    const file = findTranscript(projectsDir, sessionId);
    return file ? callCwdIn(readTailRecords(file, CALL_TAIL_BYTES), toolUseId) : undefined;
  } catch {
    // Файл переименован или занят — решаем, как без каталога.
    return undefined;
  }
}
