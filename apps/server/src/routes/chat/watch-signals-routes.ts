import type { FastifyInstance } from 'fastify';
import {
  chatWatchSignalsOf,
  type ChatWatchSignalsResponse,
  type GroupWatchCoverageSummary,
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
      groups: groupSignalsByChat(ctx),
    }),
  );
}

/**
 * Сигналы групп разделения по строкам списка чатов (F7, телефон): под настоящим
 * ключом чата группы и под ключом родителя — строка списка названа сессией, а связь
 * группы могла записаться временным `new-…`. Закрытые и битые отсеет разбор ответа.
 */
function groupSignalsByChat(ctx: ServerContext): Record<string, unknown[]> {
  const out: Record<string, unknown[]> = {};
  const add = (key: string, list: unknown[]): void => {
    out[key] = [...(out[key] ?? []), ...list];
  };
  for (const [parent, byIndex] of Object.entries(ctx.store.getAllGroupWatchSignals())) {
    const plan = ctx.store.getSplitPlan(parent);
    for (const [index, block] of Object.entries(byIndex)) {
      const list = (block as { signals?: unknown } | undefined)?.signals;
      if (!Array.isArray(list) || list.length === 0) continue;
      const chatId = plan?.groups.find((group) => group.index === Number(index))?.chatId;
      if (chatId) add(ctx.store.canonicalChatKey(chatId), list);
      add(ctx.store.canonicalChatKey(parent), list);
    }
  }
  return out;
}

/**
 * Охват сторожа групп для строки настроек: сколько живых групп каким источником
 * видно и каких источников нет у панели (журнал проверок, dev-watch, журнал лимита,
 * переписка чужого CLI). Считает сторож — он знает свои сессии.
 */
export function registerGroupWatchCoverageRoutes(
  app: FastifyInstance,
  coverage: () => GroupWatchCoverageSummary,
): void {
  app.get('/api/group-watch/coverage', (): GroupWatchCoverageSummary => coverage());
}
