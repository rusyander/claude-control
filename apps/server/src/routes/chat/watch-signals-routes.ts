import type { FastifyInstance } from 'fastify';
import {
  chatWatchSignalsOf,
  type ChatWatchSignalsResponse,
} from '@agentdeck/contracts/group-watch';
import type { ServerContext } from '../../context.ts';

/**
 * Сигналы сторожа одиночных чатов (A1): строка чата и шапка показывают то, что
 * горит сейчас. Срез пишет только сторож; закрытые и битые (ручная правка
 * `state.json`) сюда не идут — их отсеивает тот же разбор, что у клиента.
 * Освежать — по рассылке `chat-signals`.
 */
export function registerChatWatchSignalsRoutes(app: FastifyInstance, ctx: ServerContext): void {
  app.get('/api/chat/watch-signals', (): ChatWatchSignalsResponse =>
    chatWatchSignalsOf({
      signals: Object.fromEntries(
        Object.entries(ctx.store.getAllChatWatchSignals()).map(([chatId, block]) => [
          chatId,
          (block as { signals?: unknown } | undefined)?.signals,
        ]),
      ),
    }),
  );
}
