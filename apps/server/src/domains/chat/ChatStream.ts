import type { FastifyReply } from 'fastify';
import type { ChatRunRegistry, RunSubscriber, BufferedEvent } from './ChatRunRegistry.ts';
import { isRetriableRunError } from './run-errors.ts';

/**
 * Транспорт ответа: прогон отдаётся потоком SSE. Здесь только доставка кадров —
 * что именно генерируется, знает реестр прогонов.
 */

/** Заголовки SSE-ответа: держим поток открытым, ничего не кэшируем. */
export const SSE_HEADERS = {
  'Content-Type': 'text/event-stream',
  'Cache-Control': 'no-cache',
  Connection: 'keep-alive',
} as const;

/**
 * Кадр SSE. Ошибке прогона добавляем структурный `retriable` — по нему клиент
 * решает, перезапускать ли самому, не заглядывая в текст сообщения.
 */
function frame(buffered: BufferedEvent): string {
  const event = buffered.event;
  const payload =
    event.kind === 'error'
      ? { ...event, seq: buffered.seq, retriable: isRetriableRunError(event.message) }
      : { ...event, seq: buffered.seq };
  return `data: ${JSON.stringify(payload)}\n\n`;
}

/**
 * Отдать SSE-поток прогона в ответ, начиная с `fromSeq`. Держит соединение
 * живым пингом, догоняет буфер и живые события. Обрыв соединения только
 * отцепляет слушателя — прогон в реестре продолжается. Промис разрешается,
 * когда поток закрыт (прогон завершён или клиент отключился).
 */
export const streamRun = (
  registry: ChatRunRegistry,
  reply: FastifyReply,
  chatId: string,
  fromSeq: number,
): Promise<void> =>
  new Promise((resolve) => {
    reply.raw.writeHead(200, SSE_HEADERS);

    // Пинг-комментарии не дают прокси/браузеру закрыть «молчащее» соединение,
    // пока агент долго работает в инструменте. Клиент их игнорирует.
    const heartbeat = setInterval(() => {
      try {
        reply.raw.write(': ping\n\n');
      } catch {
        // Соединение уже закрыто — обработчик close всё уберёт.
      }
    }, 10_000);

    let closed = false;
    const finish = (): void => {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      try {
        reply.raw.end();
      } catch {
        // уже закрыто
      }
      resolve();
    };

    const subscriber: RunSubscriber = {
      send: (buffered) => {
        try {
          reply.raw.write(frame(buffered));
        } catch {
          // Клиент отвалился — close-обработчик отцепит.
        }
      },
      close: finish,
    };

    const unsubscribe = registry.attach(chatId, fromSeq, subscriber);

    // Клиент закрыл соединение — отцепляем слушателя, но прогон НЕ трогаем.
    reply.raw.on('close', () => {
      clearInterval(heartbeat);
      unsubscribe?.();
      resolve();
    });

    // Прогон уже завершён (буфер отдан) или его нет — закрываемся.
    if (!unsubscribe) finish();
  });

/**
 * Кадр «прогона нет»: клиент по нему прекращает переподключение, а не долбит
 * впустую. Отдаётся одним ответом, без подписки на реестр.
 */
export const streamGone = (reply: FastifyReply): void => {
  reply.raw.writeHead(200, SSE_HEADERS);
  reply.raw.write(`data: ${JSON.stringify({ kind: 'gone' })}\n\n`);
  reply.raw.end();
};
