import type { ServerResponse } from 'node:http';
import type { JournalLine } from '@agentdeck/contracts/core/journal';

/**
 * Поток событий задачи (07 §API): `id:` = `seq`, повтор пропущенного по `Last-Event-ID`,
 * `: ping` каждые 25 с (прокси и мобильная сеть рвут молчащее соединение). Сначала хвост из
 * журнала после `Last-Event-ID`, потом живые события; дубль по `seq` не уходит дважды.
 * Задача, не живая при подписке, подхватывается, когда её откроют; задача, ушедшая из живых
 * (аренда потеряна, ядро останавливается), закрывает поток — клиент переподключится по
 * `Last-Event-ID` (ревью M2, 28.10: поток слал одни пинги без конца).
 */

export const SSE_PING_MS = 25_000;

/**
 * После какого `seq` начинать. Порядок: заголовок `Last-Event-ID` (переподключение EventSource
 * повторяет тот же адрес — заголовок главнее адреса), `?lastEventId=`, потом `?from=<seq>` из
 * 07 §API — «начиная с seq» включительно, то есть после `from - 1` (ревью m2).
 */
export function lastEventId(header: string | string[] | undefined, query: unknown): number {
  const raw = Array.isArray(header) ? header[0] : header;
  const q = query && typeof query === 'object' ? (query as Record<string, unknown>) : {};
  if (raw !== undefined || q.lastEventId !== undefined) return seqOf(raw ?? q.lastEventId);
  const from = seqOf(q.from);
  return from > 0 ? from - 1 : 0;
}

function seqOf(raw: unknown): number {
  const value = Number(raw ?? 0);
  return Number.isInteger(value) && value > 0 ? value : 0;
}

export interface SseStream {
  send(line: JournalLine): void;
  close(): void;
  readonly sent: number;
  /** Последний отправленный `seq` (0 — ещё ничего). */
  readonly lastSeq: number;
  readonly closed: boolean;
}

export function openSse(
  res: ServerResponse,
  opts: { pingMs?: number; onClose: () => void },
): SseStream {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  res.write(': open\n\n');
  let lastSeq = 0;
  let sent = 0;
  let closed = false;
  const ping = setInterval(() => res.write(': ping\n\n'), opts.pingMs ?? SSE_PING_MS);
  ping.unref?.();
  const close = (): void => {
    if (closed) return;
    closed = true;
    clearInterval(ping);
    opts.onClose();
    res.end();
  };
  res.on('close', close);
  return {
    send(line) {
      if (closed || line.seq <= lastSeq) return;
      lastSeq = line.seq;
      sent += 1;
      res.write(`id: ${line.seq}\nevent: ${line.kind}\ndata: ${JSON.stringify(line)}\n\n`);
    },
    close,
    get sent() {
      return sent;
    },
    get lastSeq() {
      return lastSeq;
    },
    get closed() {
      return closed;
    },
  };
}

type Listener = (line: JournalLine) => void;
interface Subscribable {
  subscribe(listener: Listener): () => void;
}

/** Откуда поток берёт события задачи: живая задача, её появление и уход, хвост журнала. */
export interface TaskFeed {
  live(): Subscribable | undefined;
  watch(handlers: { live(task: Subscribable): void; gone(): void }): () => void;
  linesAfter(seq: number): Iterable<JournalLine>;
}

/**
 * Ведёт поток по задаче; ответ — отписка (зовётся при закрытии потока). Подписка на живую
 * задачу ставится ДО чтения хвоста: событие между ними придёт живым, дубль поток отсеет.
 */
export function followTask(stream: SseStream, feed: TaskFeed, after: number): () => void {
  let off: (() => void) | undefined;
  let unwatch: (() => void) | undefined;
  const stop = (): void => {
    off?.();
    off = undefined;
    unwatch?.();
    unwatch = undefined;
  };
  // Хвост журнала не прочитан (файл заперт, строка битая): подписка снимается, поток
  // закрывается — иначе живые строки копились бы в буфере повтора без конца (ревью F-48).
  const failed = (): void => {
    stop();
    stream.close();
  };
  const attach = (task: Subscribable): void => {
    off?.();
    const buffered: JournalLine[] = [];
    let replaying = true;
    off = task.subscribe((line) => {
      if (replaying) buffered.push(line);
      else stream.send(line);
    });
    try {
      for (const line of feed.linesAfter(Math.max(after, stream.lastSeq))) stream.send(line);
    } catch {
      failed();
      return;
    }
    replaying = false;
    for (const line of buffered) stream.send(line);
  };
  unwatch = feed.watch({ live: attach, gone: () => stream.close() });
  const now = feed.live();
  if (now) attach(now);
  else {
    try {
      for (const line of feed.linesAfter(after)) stream.send(line);
    } catch {
      failed();
    }
  }
  return stop;
}
