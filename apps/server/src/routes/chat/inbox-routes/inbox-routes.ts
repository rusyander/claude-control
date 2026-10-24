import type { FastifyInstance } from 'fastify';
import type { ServerContext } from '../../../context.ts';
import type { ChatRunRegistry } from '../../../domains/chat/ChatRunRegistry/ChatRunRegistry.ts';
import type { ChatSession } from '../../../domains/chat/ChatSession/ChatSession.ts';
import { readChats } from '../../../domains/chat/ChatHistory/ChatHistory.ts';
import {
  buildInbox,
  createTranscriptTailReader,
  liveByTail,
  type InboxRun,
} from '../../../domains/chat/chat-inbox/chat-inbox.ts';
import type { OutsideRelay } from '../../../domains/chat/outside-relay/outside-relay.ts';
import { withSources } from '../../../domains/chat/chat-inbox/ask-source.ts';
import { readAgentDefinition } from '../../../domains/chat/chat-inbox/agent-definition.ts';
import { getProvider } from '../../../providers/registry.ts';
import { projectsDir } from '../paths.ts';
import { inboxDeferredOf } from '../deferred-routes/deferred-routes.ts';

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
  relay?: OutsideRelay,
): void {
  const readTail = createTranscriptTailReader(() => projectsDir(ctx));

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
    // Прогон панели, кончившийся только что, ещё пару секунд выглядит в
    // транскрипте открытым (убитый процесс конца хода не пишет) — это не ход
    // вне панели.
    const ownSessions = new Set(
      registry
        .active()
        .map((run) => run.sessionId)
        .filter((id): id is string => Boolean(id)),
    );
    const now = Date.now();
    const links = ctx.store.getChatLinks();
    const inbox = buildInbox({
      chats: readChats(projectsDir(ctx)),
      runs,
      permissions: session.pendingPermissions(),
      outsidePermissions: (relay?.pending() ?? [])
        .filter((ask) => ask.toolName !== 'AskUserQuestion')
        .map((ask) => ({
          toolUseId: ask.toolUseId,
          sessionId: ask.sessionId,
          toolName: ask.toolName,
          input: ask.input,
          askedAt: new Date(ask.askedAt).toISOString(),
        })),
      lastAsked: (chatId) => readTail(chatId)?.asked,
      // Синоним пишет прогон, назвавший под ключом разговора другую сессию
      // (`linkChatSession`): так панель продолжает остывшую группу новым
      // разговором. Ветка правки синонима не пишет — её исходник остаётся своим.
      replaced: (sessionId) => ctx.store.canonicalChatKey(sessionId) !== sessionId,
      liveOutside: (chatId) => !ownSessions.has(chatId) && liveByTail(readTail(chatId), now),
      groupTitle: (chatId) => links[chatId]?.title,
      now,
    });
    // Чей вопрос — строкой над ним на телефоне и в Telegram: группа и стадия,
    // фоновый ли ход, CLI; у запуска агента — что, каким агентом и на чём.
    withSources(inbox, {
      link: (key) => links[key],
      parentTitle: (parent) => links[parent]?.title,
      cliName: getProvider('claude').name,
      background: (runKey) => registry.describe(runKey)?.options.hold === true,
      agentDefinition: (type, projectPath) =>
        readAgentDefinition(ctx.location.paths.root, type, projectPath),
    });
    // Отложенные вопросы D-n — отдельным разделом: прогон ушёл дальше, а
    // решение ждёт человека (главный экран телефона, кнопки — маршрут D-n).
    const deferred = inboxDeferredOf(ctx);
    if (deferred.length > 0) inbox.deferred = deferred;
    if (!relay) return inbox;
    // Вопрос, который держит хук панели, отвечается с телефона — карточке надо
    // это знать, иначе она показала бы его только для чтения.
    for (const chat of inbox.chats) {
      for (const ask of chat.asks) {
        if (ask.kind === 'question' && ask.toolUseId && relay.isPending(ask.toolUseId)) {
          ask.relay = true;
        }
      }
    }
    return inbox;
  });
}
