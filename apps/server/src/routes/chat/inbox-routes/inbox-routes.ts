import type { FastifyInstance } from 'fastify';
import type { ServerContext } from '../../../context.ts';
import type { ChatRunRegistry } from '../../../domains/chat/ChatRunRegistry/ChatRunRegistry.ts';
import type { ChatSession } from '../../../domains/chat/ChatSession/ChatSession.ts';
import { readChats } from '../../../domains/chat/ChatHistory/ChatHistory.ts';
import {
  buildInbox,
  createLastAskedReader,
  type InboxRun,
} from '../../../domains/chat/chat-inbox/chat-inbox.ts';
import { projectsDir } from '../paths.ts';

/**
 * Сводка ожиданий и активности по всем разговорам (главный экран телефона).
 * Только чтение: ответы уходят прежними маршрутами разговора, отдельного
 * «ответить из сводки» нет — второй путь к тому же брокеру разошёлся бы с первым.
 */
export function registerChatInboxRoutes(
  app: FastifyInstance,
  ctx: ServerContext,
  registry: ChatRunRegistry,
  session: ChatSession,
): void {
  const lastAsked = createLastAskedReader(() => projectsDir(ctx));

  app.get('/api/chat/inbox', () => {
    const runs: InboxRun[] = registry
      .active()
      .filter((run) => run.status === 'running')
      .map((run) => {
        const held = registry.describe(run.chatId);
        return {
          key: run.chatId,
          ...(run.sessionId ? { sessionId: run.sessionId } : {}),
          ...(run.projectPath ? { projectPath: run.projectPath } : {}),
          ...(held?.options.cwd ? { cwd: held.options.cwd } : {}),
          ...(held?.options.prompt ? { prompt: held.options.prompt } : {}),
          startedAt: run.startedAt,
        };
      });
    const links = ctx.store.getChatLinks();
    return buildInbox({
      chats: readChats(projectsDir(ctx)),
      runs,
      permissions: session.pendingPermissions(),
      lastAsked,
      groupTitle: (chatId) => links[chatId]?.title,
      now: Date.now(),
    });
  });
}
