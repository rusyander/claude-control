import type { LogLine } from '@agentdeck/contracts';

/** Сколько строк держим на цель: больше человек в окне не листает, а память — общая. */
export const LOG_BUFFER_LINES = 5000;
/** Строка длиннее обрезается: однострочный JSON на мегабайт подвесил бы окно. */
export const LOG_LINE_CHARS = 4000;

// Цвета и движения курсора: панель их не рисует, а поиск по «error» спотыкался бы о `\x1b[31m`.
// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07]*(?:\x07|\x1b\\)/g;

export const stripAnsi = (text: string): string => text.replace(ANSI, '');

interface BufferedLine extends LogLine {
  seq: number;
}

/**
 * Вывод цели запуска построчно, с номерами: клиент спрашивает «после N» и
 * получает только новое. Куски из stdout и stderr склеиваются в строки каждый
 * отдельно — иначе строка ошибки, пришедшая между двумя половинами строки
 * stdout, разрезала бы её.
 */
export class LogBuffer {
  private lines: BufferedLine[] = [];
  private next = 1;
  private readonly partial: Record<'stdout' | 'stderr', string> = { stdout: '', stderr: '' };
  private readonly now: () => Date;

  constructor(now: () => Date = () => new Date()) {
    this.now = now;
  }

  push(stream: 'stdout' | 'stderr', chunk: string): void {
    const text = this.partial[stream] + chunk;
    const parts = text.split(/\r?\n/);
    this.partial[stream] = parts.pop() ?? '';
    // Строка без перевода, растущая без конца (прогресс-бар через \r), всё равно показывается.
    if (this.partial[stream].length > LOG_LINE_CHARS) {
      parts.push(this.partial[stream]);
      this.partial[stream] = '';
    }
    for (const part of parts) this.add(stream, part);
  }

  private add(stream: 'stdout' | 'stderr', raw: string): void {
    // `\r` внутри строки — перерисовка: видна последняя версия.
    const text = stripAnsi(raw.slice(raw.lastIndexOf('\r') + 1)).slice(0, LOG_LINE_CHARS);
    this.lines.push({ seq: this.next++, at: this.now().toISOString(), stream, text });
    if (this.lines.length > LOG_BUFFER_LINES)
      this.lines.splice(0, this.lines.length - LOG_BUFFER_LINES);
  }

  /**
   * Строки после номера `after` (0 — с начала буфера). `truncated` — между
   * `after` и первой отданной строкой что-то уже вытеснено.
   */
  since(after: number): { lines: LogLine[]; last: number; truncated: boolean } {
    const first = this.lines[0]?.seq ?? this.next;
    const from = this.lines.findIndex((line) => line.seq > after);
    const picked = from < 0 ? [] : this.lines.slice(from);
    return {
      lines: picked.map(({ seq: _seq, ...line }) => line),
      last: this.next - 1,
      truncated: first > after + 1,
    };
  }
}

/** Вывод цели для «Логов»: идущей или остановленной (последний запуск). */
export interface RunLog {
  projectPath: string;
  dir: string;
  name: string;
  command: string;
  startedAt: string;
  /** Стадия запуска; у остановленной — `stopped`. */
  state: string;
  log: LogBuffer;
}

/** Сколько остановленных целей помнит панель — по одной на цель, старые уходят первыми. */
export const FINISHED_LOGS = 30;

/**
 * Вывод остановленных целей: после «Стоп» человек часто как раз и идёт читать,
 * почему сервер вёл себя не так, — пропадать вместе с процессом вывод не должен.
 */
export class FinishedLogs {
  private readonly items = new Map<string, RunLog>();

  keep(key: string, run: RunLog): void {
    this.items.delete(key);
    this.items.set(key, { ...run, state: 'stopped' });
    if (this.items.size > FINISHED_LOGS) {
      const oldest = this.items.keys().next().value;
      if (oldest !== undefined) this.items.delete(oldest);
    }
  }

  entries(): [string, RunLog][] {
    return [...this.items.entries()];
  }
}
