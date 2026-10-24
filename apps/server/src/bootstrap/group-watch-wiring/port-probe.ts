import { createConnection } from 'node:net';

/**
 * Проба портов для R36 (свой сервер сессии пережил паузу группы). Правила сторожа
 * чистые и синхронные, а соединение — нет: `alive` отвечает по последней пробе и
 * заказывает новую, если та устарела. Первый ответ по порту — «не слушает»: сигнал
 * поднимется тиком позже, ложной тревоги до пробы нет.
 */

/** Проба старше этого — заказать новую. Тик сторожа — минута. */
const PROBE_TTL_MS = 30_000;
/** Соединение с локальным портом дольше этого — порт не отвечает. */
const CONNECT_TIMEOUT_MS = 1000;

/** Слушает ли порт на петле: соединение принято — да; отказ, ошибка или срок — нет. */
export function probePort(port: number, host = '127.0.0.1'): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host, port });
    const done = (alive: boolean): void => {
      socket.destroy();
      resolve(alive);
    };
    socket.setTimeout(CONNECT_TIMEOUT_MS, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

export interface PortProbe {
  alive: (port: number) => boolean;
  /** Дождаться всех заказанных проб — для проверок. */
  settle: () => Promise<void>;
}

export function createPortProbe(
  probe: (port: number) => Promise<boolean> = probePort,
  now: () => number = Date.now,
): PortProbe {
  const known = new Map<number, { alive: boolean; at: number }>();
  const pending = new Map<number, Promise<void>>();
  const order = (port: number): void => {
    if (pending.has(port)) return;
    const run = probe(port)
      .then((alive) => {
        known.set(port, { alive, at: now() });
      })
      .catch(() => {
        known.set(port, { alive: false, at: now() });
      })
      .finally(() => pending.delete(port));
    pending.set(port, run);
  };
  return {
    alive: (port) => {
      if (!Number.isInteger(port) || port <= 0 || port > 65_535) return false;
      const last = known.get(port);
      if (!last || now() - last.at > PROBE_TTL_MS) order(port);
      return last?.alive === true;
    },
    settle: async () => {
      await Promise.all([...pending.values()]);
    },
  };
}
