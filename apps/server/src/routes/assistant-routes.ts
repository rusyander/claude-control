import type { FastifyInstance } from 'fastify';
import { askAssistant, type AssistRequest } from '../domains/assistant.ts';

/**
 * Маршрут помощника. Ответ приходит за секунды, поэтому клиент обязан
 * показывать ожидание — форма при этом остаётся доступной для ручной правки.
 */
export function registerAssistantRoutes(app: FastifyInstance): void {
  app.post<{ Body: AssistRequest }>('/api/assist', (request) => askAssistant(request.body));
}
