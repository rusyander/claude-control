import type { FastifyInstance } from 'fastify';
import type { AssistantRunRequest, AssistantRunResult } from '@claude-control/contracts';
import type { ServerContext } from '../context.ts';
import { askAssistant, type AssistRequest } from '../domains/assistant.ts';
import { runAssistant, type AssistantMessage } from '../domains/assistant-runner.ts';
import { activeCliCommand } from '../providers/cli.ts';
import { getActiveProvider } from '../providers/registry.ts';

/**
 * Маршрут помощника. Ответ приходит за секунды, поэтому клиент обязан
 * показывать ожидание — форма при этом остаётся доступной для ручной правки.
 *
 * `/api/assist` — помощник по заполнению форм (Claude-путь, без изменений).
 * `/api/assistant/run` — мультимодельный ассистент по активному провайдеру
 * (Ф6b): claude делегирует своему существующему CLI-пути, прочие идут через
 * новые раннеры (cli/api) по switch. Секреты/ключи не логируем.
 */
export function registerAssistantRoutes(app: FastifyInstance, ctx: ServerContext): void {
  app.post<{ Body: AssistRequest }>('/api/assist', (request) =>
    askAssistant(request.body, activeCliCommand(ctx.store)),
  );

  app.post<{ Body: AssistantRunRequest }>('/api/assistant/run', async (request) => {
    const provider = getActiveProvider(ctx.store);
    const messages: AssistantMessage[] = Array.isArray(request.body?.messages)
      ? request.body.messages
          .filter((m) => m && typeof m.content === 'string')
          .map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content }))
      : [];
    const result = await runAssistant(provider, messages, {
      appDataDir: ctx.location.paths.appData,
      // Только кэш: ассистент не должен ждать сеть ради имени модели.
      models: ctx.models.current(provider.modelVendors ?? []).models,
      // IDEA-8: id диалога включает сессионный режим у тех CLI, кто его заявил
      // (сейчас OpenCode). Не прислали — всё идёт one-shot, как и раньше.
      conversationId:
        typeof request.body?.conversationId === 'string' && request.body.conversationId.trim()
          ? request.body.conversationId.trim().slice(0, 120)
          : undefined,
    });
    return result satisfies AssistantRunResult;
  });
}
