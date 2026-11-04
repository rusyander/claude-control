import type { FastifyInstance } from 'fastify';
import type { ServerContext } from '../../../context.ts';
import type { ChatAwaitingView } from '@agentdeck/contracts/chat-handoff';
import type { TreePause } from '../../../domains/chat/tree-pause/tree-pause.ts';

/**
 * Дерево разговоров одной просьбы и его пауза.
 *
 * Адресуется ЛЮБЫМ разговором дерева: корень домен находит сам по связям, так
 * что «Остановить всё», нажатое у ребёнка, останавливает то же дерево, что и
 * у родителя, — а не ветку под ребёнком. Ветку останавливать отдельно нет
 * смысла: звенья и продолжения заводит сверху планировщик, и стоять должно
 * всё, чему он может дать старт.
 */
export function registerChatTreeRoutes(
  app: FastifyInstance,
  _ctx: ServerContext,
  tree: TreePause,
): void {
  // Кто из деревьев ждёт человека — вкладка звонит по нему и скрытой.
  app.get('/api/chat/awaiting', (): ChatAwaitingView => ({ chats: tree.awaiting() }));

  app.get<{ Params: { id: string } }>('/api/chat/:id/tree', (request) =>
    tree.view(request.params.id),
  );

  app.post<{ Params: { id: string } }>('/api/chat/:id/tree/pause', (request) =>
    tree.pause(request.params.id),
  );

  app.post<{ Params: { id: string } }>('/api/chat/:id/tree/resume', (request) =>
    tree.resume(request.params.id),
  );
}
