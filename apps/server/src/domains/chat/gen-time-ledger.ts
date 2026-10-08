import { join } from 'node:path';
import { readJsonFile, writeTextFile } from '../../lib/safe-io.ts';

/**
 * Журнал времени генерации ответов: id сообщения модели → мс генерации выхода.
 *
 * ПОЧЕМУ ОН ЕСТЬ. Скорость ответа (ток/с) видна в ленте только по времени из
 * живого потока, а Claude Code в транскрипт его не пишет. Без журнала скорость
 * держалась бы, пока ответ идёт, и пропадала бы в момент, когда ход кончился и
 * лента перечитала транскрипт (живой прогон 08.10), — то есть ровно тогда, когда
 * человек на неё смотрит.
 *
 * ЧЕМ ПРИВЯЗАНО. Точным ключом — id сообщения из `message_start`; Claude Code
 * пишет тот же id в транскрипт, и лента находит по нему ТОТ ответ. Пишутся
 * только ходы не облачного Claude: скорость показывается только им (`generationSpeed`
 * в вебе), а запись на каждый ход облака была бы диском впустую.
 */

const FILE = 'chat-gen-times.json';
/** Сколько последних ответов помним. Старше — скорость у ответа гаснет. */
export const GEN_TIMES_CAP = 2000;

type Entry = [messageId: string, genMs: number];

/** Кэш на процесс: лента читает журнал на каждую страницу переписки. */
const cache = new Map<string, Entry[]>();

function fileOf(appDataDir: string): string {
  return join(appDataDir, FILE);
}

function isEntry(value: unknown): value is Entry {
  return (
    Array.isArray(value) &&
    typeof value[0] === 'string' &&
    typeof value[1] === 'number' &&
    value[1] > 0
  );
}

function readEntries(appDataDir: string): Entry[] {
  const cached = cache.get(appDataDir);
  if (cached) return cached;
  let entries: Entry[];
  try {
    const raw = readJsonFile<unknown>(fileOf(appDataDir), []);
    entries = Array.isArray(raw) ? raw.filter(isEntry) : [];
  } catch {
    // Испорченный файл — не повод ронять ленту: скорость начнётся с чистого листа.
    entries = [];
  }
  cache.set(appDataDir, entries);
  return entries;
}

/** Нужен ли ход журналу: облачный Claude скорости в ленте не получает. */
export function wantsGenTime(model: string | undefined): boolean {
  return Boolean(model) && !/^claude/i.test(model ?? '');
}

/** Записать время генерации ответа. Сбой записи не ломает ход — он уже ушёл вкладке. */
export function noteGenTime(appDataDir: string, messageId: string, genMs: number): void {
  if (!messageId || !(genMs > 0)) return;
  const kept = readEntries(appDataDir).filter(([id]) => id !== messageId);
  const next: Entry[] = [...kept, [messageId, genMs] as Entry].slice(-GEN_TIMES_CAP);
  cache.set(appDataDir, next);
  try {
    // Одной строкой: файл переписывается на каждом шаге локальной модели, а
    // отступы почти удваивали его при потолке в GEN_TIMES_CAP записей.
    writeTextFile(fileOf(appDataDir), `${JSON.stringify(next)}\n`, { preserveForm: false });
  } catch {
    // В памяти запись осталась: до перезапуска скорость видна.
  }
}

/**
 * Приёмник для реестра прогонов (`ChatRunRegistry.setGenTimeSink`): пишет только
 * то, что лента потом покажет.
 */
export function genTimeSink(
  appDataDir: string,
): (messageId: string, genMs: number, model: string | undefined) => void {
  return (messageId, genMs, model) => {
    if (wantsGenTime(model)) noteGenTime(appDataDir, messageId, genMs);
  };
}

/** Время генерации по id сообщения — для ленты из транскрипта. */
export function genTimesById(appDataDir: string): Map<string, number> {
  return new Map(readEntries(appDataDir));
}
