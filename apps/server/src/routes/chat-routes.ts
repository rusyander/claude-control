import type { FastifyInstance } from 'fastify';
import type { ServerContext } from '../context.ts';
import type { ChatRunRegistry } from '../domains/chat/ChatRunRegistry.ts';
import { registerChatTranscriptRoutes } from './chat/transcript-routes.ts';
import { registerChatBrowseRoutes } from './chat/browse-routes.ts';
import { registerChatRunRoutes } from './chat/run-routes.ts';
import { registerChatArtifactRoutes } from './chat/artifact-routes.ts';

/**
 * Классификация ошибок CLI живёт в домене; здесь она переэкспортирована, чтобы
 * путь импорта у теста маршрутов остался прежним.
 */
export { isRetriableRunError } from '../domains/chat/run-errors.ts';

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
): void {
  registerChatTranscriptRoutes(app, ctx);
  registerChatBrowseRoutes(app, ctx);
  registerChatRunRoutes(app, ctx, registry);
  registerChatArtifactRoutes(app, ctx);
}
