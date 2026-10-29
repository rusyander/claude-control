import { join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';

/**
 * Хост сессии (00 §session host, 01 §Sessions at core death, P89): крошечный процесс на
 * сессию. Он запускает CLI со stdout/stderr ПРЯМО В ФАЙЛЫ (вывод не держится в памяти
 * хоста и не теряется ни при смерти ядра, ни при смерти хоста), держит stdin CLI и слушает
 * канал управления. Ядро умерло — CLI и хост живут; новое ядро подключается по личности
 * хоста (номер + старт), дочитывает файлы от своего смещения из журнала и продолжает.
 *
 * Каталог сессии (внутри дома ядра):
 * - `spec.json` — описание запуска с окружением CLI (там бывают ключи): пишется 0600,
 *   хост удаляет его сразу после чтения и окружения нигде не хранит (P112);
 * - `token` — ключ канала, 0600; в журнал не пишется никогда, ядро читает его из файла;
 * - `host.json` — личность хоста и CLI, путь канала (атомарная замена, признак готовности);
 * - `stdout.log`, `stderr.log` — вывод CLI как есть, только дописывается;
 * - `exit.json` — исход CLI (код, сигнал, остановлен ли, отказ запуска, остаток и сомнение остановки).
 *
 * Канал — JSON-строки. Клиент → хост: `hello{token}` первым, затем `input{cmdId,data}`,
 * `end`, `stop{graceMs}`, `status`. Хост → клиент: `welcome`, `ack{cmdId,dup}` (ввод записан
 * в stdin CLI), `refused{cmdId,reason}` (ввод НЕ записан: stdin закрыт, CLI вышел, ошибка
 * записи), `ended`, `status`, `stopped{residual,unknown?}`, `exit{…}`. Вывод по каналу НЕ идёт: его
 * читают из файлов от смещения — так повтор после переподключения точен до байта.
 */

export const FILES = {
  spec: 'spec.json',
  token: 'token',
  host: 'host.json',
  stdout: 'stdout.log',
  stderr: 'stderr.log',
  exit: 'exit.json',
  hostErr: 'host.err',
} as const;

export type StreamName = 'stdout' | 'stderr';

export function sessionFile(dir: string, name: keyof typeof FILES): string {
  return join(dir, FILES[name]);
}

export interface Identity {
  pid: number;
  start: string;
}

/** Что ядро передаёт хосту через `spec.json` (и только так). */
export interface HostSpec {
  v: 1;
  /** Метка дерева CLI (`AGENTDECK_TREE=<id>`) для поиска переродителей при остановке. */
  sessionId: string;
  command: string;
  args: string[];
  cwd: string;
  /** Окружение CLI целиком (закреплённое); живёт только в памяти хоста. */
  env: Record<string, string>;
  extraDirs?: string[];
  channel: string;
  /** Хост без клиента и без вывода дольше этого — всё равно ждёт CLI; поле — запас на будущее. */
  graceMs?: number;
}

export interface HostRecord {
  v: 1;
  host: Identity;
  child: Identity | null;
  channel: string;
  startedAt: number;
}

export interface ExitRecord {
  v: 1;
  code: number | null;
  signal: string | null;
  /** CLI снят по команде `stop`. */
  stopped: boolean;
  /** Запуск CLI отказан (не найден, обёртка не распознана, cwd) — причина. */
  refused?: string;
  residual?: Identity[];
  /**
   * Остановка не доказана (снимок, поиск по метке или сверка не прочитаны) — причина. Нет поля —
   * доказана; старые записи без поля читаются как прежде.
   */
  unknown?: string;
  at: number;
}

/** Отчёт хоста об остановке дерева CLI: остаток и, если не доказано, причина сомнения. */
export interface HostStopReport {
  residual: Identity[];
  unknown?: string;
}

export type ClientMessage =
  | { t: 'hello'; token: string }
  | { t: 'input'; cmdId: string; data: string }
  | { t: 'end' }
  | { t: 'stop'; graceMs?: number }
  | { t: 'status' };

export type HostMessage =
  | { t: 'welcome'; host: Identity; child: Identity | null; exited: ExitRecord | null }
  | { t: 'ack'; cmdId: string; dup: boolean }
  | { t: 'refused'; cmdId: string; reason: string }
  | { t: 'ended' }
  | ({ t: 'stopped' } & HostStopReport)
  | { t: 'status'; inputs: number; stdinOpen: boolean }
  | { t: 'exit'; exit: ExitRecord };

export function encode(message: ClientMessage | HostMessage): string {
  return `${JSON.stringify(message)}\n`;
}

/** Разбор строки канала: не JSON или без `t` — `undefined` (строка отбрасывается). */
export function decode<T extends { t: string }>(line: string): T | undefined {
  try {
    const value = JSON.parse(line) as unknown;
    return value && typeof value === 'object' && typeof (value as { t?: unknown }).t === 'string'
      ? (value as T)
      : undefined;
  } catch {
    return undefined;
  }
}

/** Строки из потока байтов: хвост без `\n` остаётся в буфере до следующего куска. */
export function lineSplitter(onLine: (line: string) => void): (chunk: Buffer) => void {
  let tail = '';
  // Многобайтовый знак, разрезанный границей куска, собирается декодером, а не портится.
  const decoder = new StringDecoder('utf8');
  return (chunk) => {
    tail += decoder.write(chunk);
    let at = tail.indexOf('\n');
    while (at >= 0) {
      const line = tail.slice(0, at).replace(/\r$/, '');
      tail = tail.slice(at + 1);
      if (line.trim()) onLine(line);
      at = tail.indexOf('\n');
    }
  };
}
