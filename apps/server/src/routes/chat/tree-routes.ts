import type { FastifyInstance } from 'fastify';
import type { ServerContext } from '../../context.ts';
import type { SplitPlanView } from '@agentdeck/contracts/chat-handoff';
import type { TreePause } from '../../domains/chat/tree-pause.ts';

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
  /** Конвейер уровней (Т1) по ключам дерева; нет — пульт без него. */
  split?: (chatIds: string[]) => SplitPlanView | undefined,
): void {
  app.get<{ Params: { id: string } }>('/api/chat/:id/tree', (request) => {
    const view = tree.view(request.params.id);
    // Запись конвейера лежит под ключом родителя — временным или настоящим;
    // дерево знает оба, и по любому из них пульт получает уровни.
    const keys = [view.root, ...view.nodes.flatMap((node) => [node.chatId, ...node.aliases])];
    const plan = split?.(keys);
    return plan ? { ...view, split: plan } : view;
  });

  app.post<{ Params: { id: string } }>('/api/chat/:id/tree/pause', (request) =>
    tree.pause(request.params.id),
  );

  app.post<{ Params: { id: string } }>('/api/chat/:id/tree/resume', (request) =>
    tree.resume(request.params.id),
  );
}
