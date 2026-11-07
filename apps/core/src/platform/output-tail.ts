import { closeSync, constants, fstatSync, openSync, readSync, statSync } from 'node:fs';

/**
 * Хвост файла вывода фоновой работы (этап 11, P148): CLI пишет вывод в свой файл
 * (`<tmp сессии>/tasks/<id>.output`), ядро читает только его конец и только при показе — в журнал
 * вывод не попадает никогда. Чтение ограничено: файл в гигабайт не тянется в память целиком.
 * Маску DLP кладёт вызывающий (та же, что у журнала): здесь только байты.
 */

/** Сколько байт конца файла отдаётся по умолчанию. */
export const OUTPUT_TAIL_BYTES = 16 * 1024;

export type OutputTail = { text: string; truncated: boolean; size: number } | { missing: string };

/**
 * Начало показа в обрезанном окне (`window[0]` — байт ПЕРЕД окном): после первого перевода
 * строки, нет его — после первого пробела, нет и пробела — ничего. Маска DLP узнаёт секрет по
 * его виду и контексту («sk-ant-…», «PASSWORD=…»); обломок, отрезанный окном от начала, она не
 * узнала бы и отдала бы как есть. Байты ASCII не встречаются внутри символа UTF-8 — граница
 * после них всегда на целом символе.
 */
function cutStart(window: Buffer): number {
  const nl = window.indexOf(0x0a);
  if (nl >= 0) return nl + 1;
  const space = window.findIndex((b) => b === 0x20 || b === 0x09 || b === 0x0d);
  return space >= 0 ? space + 1 : window.length;
}

const reasonOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const notRegular = (path: string): string =>
  `${path}: not a regular file (FIFO, device or directory), not read`;

/**
 * Без блокировки там, где ОС её знает (POSIX): открытие FIFO без писателя не ждёт, а `fstat`
 * открытого отказывает всему, что не обычный файл. На Windows флага нет — там открытие канала и
 * каталога и так не ждёт.
 */
const OPEN_FLAGS = constants.O_RDONLY | (constants.O_NONBLOCK ?? 0);

/**
 * Последние `maxBytes` байт файла (не больше). Обрезанное окно начинается с целой строки (или
 * слова в одной длинной строке): обломок первой строки не показывается — ни «�», ни кусок секрета.
 * Пока работа идёт (`ended = false`), последняя строка без перевода строки ещё пишется — она
 * придержана до конца строки: секрет, записанный двумя кусками, не отдаётся префиксом, который
 * маска не узнала бы. Кончилась работа — строка больше не допишется и отдаётся целой.
 * Читается только обычный файл: FIFO, устройство, каталог — отказ с причиной, поток ядра не ждёт.
 */
export function readOutputTail(
  path: string,
  maxBytes = OUTPUT_TAIL_BYTES,
  ended = false,
): OutputTail {
  let fd: number;
  try {
    fd = openSync(path, OPEN_FLAGS);
  } catch (error) {
    return { missing: reasonOf(error) };
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) return { missing: notRegular(path) };
    const size = stat.size;
    const length = Math.min(size, Math.max(0, maxBytes));
    const truncated = size > length;
    // Обрезанное окно читается с байтом перед ним: по нему видно, не с целой ли строки окно.
    const want = truncated ? length + 1 : length;
    const buffer = Buffer.alloc(want);
    const read = want > 0 ? readSync(fd, buffer, 0, want, size - want) : 0;
    const start = truncated ? cutStart(buffer.subarray(0, read)) : 0;
    const end = ended ? read : Math.max(start, buffer.lastIndexOf(0x0a, read - 1) + 1);
    return { text: buffer.subarray(start, end).toString('utf8'), truncated, size };
  } catch (error) {
    return { missing: reasonOf(error) };
  } finally {
    closeSync(fd);
  }
}

/**
 * Размер файла вывода — мера продвижения фоновой работы; `null` — файла нет, не прочитан или это
 * не обычный файл (у каталога и FIFO «неподвижный размер» — не тишина вывода).
 */
export function outputSize(path: string): number | null {
  try {
    const stat = statSync(path);
    return stat.isFile() ? stat.size : null;
  } catch {
    return null;
  }
}
