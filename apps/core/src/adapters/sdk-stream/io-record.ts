import {
  appendFileSync,
  closeSync,
  existsSync,
  fstatSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
} from 'node:fs';
import { join } from 'node:path';
import { sessionFile } from '../../session-host/protocol.ts';

/**
 * Запись ввода ядра в сеанс (`core-io.jsonl` в каталоге сеанса) — то, чего нет в выводе хоста:
 * какие отправки ядро сделало, с какого смещения stdout.log оно ждало их хода и что хост
 * подтвердил. Новое ядро по ней восстанавливает насос прежнего (01 §Sessions at core death,
 * P89): ожидание хода встаёт на то же место потока, отправка без подтверждения уходит тем же
 * cmdId (хост дубль не пишет), отвеченный управляющий запрос второй раз не задаётся.
 *
 * Отправка пишется ДО записи в хост (дошедшая до хоста всегда записана), подтверждения и ответы
 * на управляющие запросы — ПОСЛЕ ack: потерянная запись ответа значит лишь повтор, который хост
 * отбросит. Строка, оборванная смертью ядра, пропускается; следующая запись начинается с новой
 * строки (ревью core-s2 F-23: приклеенная к обрывку строка терялась вместе с ним).
 */

export const IO_RECORD = 'core-io.jsonl';

export interface RecordedSend {
  cmdId: string;
  uuid: string;
  /** Смещение stdout.log, на котором насос стал ждать хода этой отправки. */
  at: number;
  /**
   * Длина stdout.log в миг записи отправки (запись с прохода 8 зоны C, 03.11; прежние — без неё).
   * `at` — место насоса, оно отстаёт от файла: курсор вида, ушедший за `at` до записи отправки,
   * терял ход человека в живой ленте («живьём 0, после перезагрузки 1»). Курсор вида — конец
   * целой строки на миг его чтения, а файл только растёт, так что `seen` не меньше любого курсора,
   * выданного до записи: показ по `seen` отдаёт такую отправку ровно один раз.
   */
  seen?: number;
  /**
   * Стена (мс эпохи) записи отправки (этап 11, волна 3; прежние записи — без неё). Время хода
   * человека для истории чата не-Claude CLI: вид сеанса времени строк не несёт, а лента панели
   * отделяет прошлые ответы от идущего хода по времени (`withoutLiveTurn`).
   */
  wall?: number;
  data: string;
  acked: boolean;
}

/** Где ход человека встаёт в ленте вида: не раньше длины вывода на миг его записи. */
export function shownAt(send: Pick<RecordedSend, 'at' | 'seen'>): number {
  return Math.max(send.at, send.seen ?? send.at);
}

export interface IoRecord {
  sends: RecordedSend[];
  /** Id управляющих запросов, ответ на которые хост подтвердил (`initialize` — тоже). */
  controls: Set<string>;
}

type Line =
  | {
      t: 'send';
      cmdId: string;
      uuid: string;
      at: number;
      seen?: number;
      wall?: number;
      data: string;
    }
  | { t: 'ack'; cmdId: string }
  | { t: 'control'; id: string };

function parse(text: string): Line | null {
  try {
    const value = JSON.parse(text) as Partial<Line> & Record<string, unknown>;
    if (value.t === 'send' && typeof value.cmdId === 'string' && typeof value.at === 'number') {
      // `seen` не число — как записи до прохода 8: показ по `at`.
      if (value.seen !== undefined && typeof value.seen !== 'number') delete value.seen;
      // `wall` не число — как записи до волны 3: времени хода вид не называет.
      if (value.wall !== undefined && typeof value.wall !== 'number') delete value.wall;
      return value as Line;
    }
    if (value.t === 'ack' && typeof value.cmdId === 'string') return value as Line;
    if (value.t === 'control' && typeof value.id === 'string') return value as Line;
    return null;
  } catch {
    return null;
  }
}

/** `{"t":` внутри строкового значения экранируется (`{\"t\":`), так что сырая — только начало строки. */
const LINE_START = '{"t":';

/**
 * Строка, склеенная с обрывком прежнего ядра (файл, записанный до F-23): обрывок отбрасывается,
 * целая запись за ним читается.
 */
function parseRecovering(text: string): Line | null {
  const line = parse(text);
  if (line) return line;
  const start = text.lastIndexOf(LINE_START);
  return start > 0 ? parse(text.slice(start)) : null;
}

/** Нет файла — сеанс ничего не получал; нечитаемый файл — исключение (не «пусто»). */
export function readIoRecord(dir: string): IoRecord {
  const path = join(dir, IO_RECORD);
  const record: IoRecord = { sends: [], controls: new Set() };
  if (!existsSync(path)) return record;
  const byId = new Map<string, RecordedSend>();
  for (const text of readFileSync(path, 'utf8').split('\n')) {
    const line = text.trim() ? parseRecovering(text) : null;
    if (!line) continue;
    if (line.t === 'send') {
      if (byId.has(line.cmdId)) continue;
      const send: RecordedSend = { ...line, acked: false };
      byId.set(line.cmdId, send);
      record.sends.push(send);
    } else if (line.t === 'ack') {
      const send = byId.get(line.cmdId);
      if (send) send.acked = true;
    } else {
      record.controls.add(line.id);
    }
  }
  return record;
}

/** Хвост файла оборван (нет завершающего `\n`) — смерть ядра посреди append. */
function endsTorn(path: string): boolean {
  if (!existsSync(path)) return false;
  const fd = openSync(path, 'r');
  try {
    const size = fstatSync(fd).size;
    if (size === 0) return false;
    const last = Buffer.alloc(1);
    readSync(fd, last, 0, 1, size - 1);
    return last[0] !== 0x0a;
  } finally {
    closeSync(fd);
  }
}

/** Длина stdout.log сеанса; файла ещё нет — 0. */
function stdoutSize(dir: string): number {
  return statSync(sessionFile(dir, 'stdout'), { throwIfNoEntry: false })?.size ?? 0;
}

/**
 * Отправка получает `seen` здесь, у единственного писателя записи (насосы stream-json и JSON-RPC):
 * длина вывода снимается ПОСЛЕ того, как насос решил отправлять, — любой курсор вида, выданный
 * раньше, не больше её. Заданный вызывающим `seen` главнее (восстановление, тесты).
 * Там же — `wall`, стена записи отправки (время хода человека в истории чата); заданная главнее.
 */
export function appendIoRecord(dir: string, line: Line, now: () => number = Date.now): void {
  const path = join(dir, IO_RECORD);
  const stamped =
    line.t === 'send'
      ? { ...line, seen: line.seen ?? stdoutSize(dir), wall: line.wall ?? now() }
      : line;
  // Обрывок прежнего ядра закрывается переводом строки: иначе эта запись склеится с ним.
  const lead = endsTorn(path) ? '\n' : '';
  appendFileSync(path, `${lead}${JSON.stringify(stamped)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
}
