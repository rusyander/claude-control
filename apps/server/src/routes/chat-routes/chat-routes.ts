import { dirname, join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { apiTokenPath } from '../../lib/api-token/api-token.ts';
import type { ServerContext } from '../../context.ts';
import type { ChatRunRegistry } from '../../domains/chat/ChatRunRegistry/ChatRunRegistry.ts';
import type { ChatSession } from '../../domains/chat/ChatSession/ChatSession.ts';
import { registerChatTranscriptRoutes } from '../chat/transcript-routes/transcript-routes.ts';
import { registerChatBrowseRoutes } from '../chat/browse-routes.ts';
import { registerChatRunRoutes } from '../chat/run-routes/run-routes.ts';
import { registerChatArtifactRoutes } from '../chat/artifact-routes.ts';
import { registerChatCliRoutes } from '../chat/cli-routes/cli-routes.ts';
import { registerChatInboxRoutes } from '../chat/inbox-routes/inbox-routes.ts';
import { registerOutsideRelayRoutes } from '../chat/outside-relay-routes/outside-relay-routes.ts';
import { OutsideRelay } from '../../domains/chat/outside-relay/outside-relay.ts';

/**
 * Классификация ошибок CLI живёт в домене; здесь она переэкспортирована, чтобы
 * путь импорта у теста маршрутов остался прежним.
 */
export { isRetriableRunError } from '../../domains/chat/run-errors/run-errors.ts';

/**
 * Маршруты чата. Ответ отдаётся потоком (SSE): пользователь видит текст по мере
 * генерации, как в самом Claude Code.
 *
 * Прогоны живут в реестре, отвязанном от HTTP-запроса: обрыв соединения или уход
 * на другую вкладку не убивают агента, а к идущему прогону можно переподключиться
 * потоком, догнав пропущенное. Остановка — только по явной кнопке.
 *
 * Реестр приходит снаружи и параметр обязателен: он живёт дольше запроса, и
 * создать его должен тот, кто сможет погасить прогоны при выходе, — `index.ts`.
 * Прежнее значение по умолчанию это молча ломало: модуль заводил собственный
 * реестр, до которого снаружи было уже не дотянуться. В тестах передача реестра
 * — единственный способ поставить маршруты в состояние «прогон уже идёт», не
 * запуская настоящий CLI.
 *
 * Сами маршруты разложены по `chat/*`: чтение переписки, обзор диска, прогон
 * агента и артефакты песочницы; здесь только сборка.
 */
export function registerChatRoutes(
  app: FastifyInstance,
  ctx: ServerContext,
  registry: ChatRunRegistry,
  /**
   * Права и автоподтверждение — общие на сервер: тумблер, щёлкнутый в чате, и
   * решение по правам должны попадать в тот же объект, что читает прогон.
   * Обязателен нарочно: забытый аргумент завёл бы второе, молчаливое состояние.
   */
  session: ChatSession,
  /** Ждёт ли разговор дерева человека — метка «ждёт вас» в списке чатов. */
  awaitsYou?: (chatId: string) => boolean,
  /** Модель, назначенная лёгкому чату вопросов о ходе групп (5.1). */
  assignedOf?: (chatId: string) => { model: string; effort: string } | undefined,
): void {
  registerChatTranscriptRoutes(
    app,
    ctx,
    (chatId) => registry.isProcessAlive(chatId),
    awaitsYou,
    assignedOf,
  );
  registerChatBrowseRoutes(app, ctx);
  registerChatRunRoutes(app, ctx, registry, session, assignedOf);
  registerChatArtifactRoutes(app, ctx);
  registerChatCliRoutes(app, undefined, () => ctx.store);
  // Вопросы сессий из терминала и VS Code: сводка помечает те, что ждут
  // телефона, маршруты ретранслятора их закрывают — объект один на обоих.
  const relay = new OutsideRelay({
    enabled: () => ctx.store.getOutsideRelay(),
    ownSession: (sessionId) => registry.active().some((run) => run.sessionId === sessionId),
    // Рядом с токеном: хук находит папку от своего `--token-file`.
    flagDir: join(dirname(apiTokenPath()), 'outside-queue'),
  });
  registerChatInboxRoutes(app, ctx, registry, session, relay);
  registerOutsideRelayRoutes(app, ctx, relay);
}
