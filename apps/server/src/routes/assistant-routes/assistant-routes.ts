import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AssistantRunRequest, AssistantRunResult } from '@agentdeck/contracts';
import type { ServerContext } from '../../context.ts';
import { askAssistant } from '../../domains/assistant/assistant.ts';
import { helperAskFor, type HelperRouteWiring } from '../../domains/assistant-route.ts';
import {
  runAssistant,
  type AssistantMessage,
} from '../../domains/assistant-runner/assistant-runner.ts';
import { resolveAssistantEndpoint } from '../../domains/endpoints/endpoints.ts';
import { getActiveProvider } from '../../providers/registry.ts';
import { readAgentImages } from '../../lib/agent-images/agent-images.ts';

/** Тело с картинками: до восьми по 3,75 МБ в base64 — предел по умолчанию (1 МБ) мал. */
const ASSIST_BODY_LIMIT = 48 * 1024 * 1024;

/**
 * История окна помощника: сессии у него нет (лёгкое окно, D4), и разговор
 * продолжается прежними репликами в теле. Общая с помощником структуры.
 */
export const assistHistorySchema = z
  .array(z.object({ role: z.enum(['user', 'assistant']), text: z.string().max(20_000) }))
  .max(200);

/**
 * Тело помощника формы. Прежний `sessionId` старой вкладки не отказ: лишние
 * ключи схема молча отбрасывает, продолжать всё равно нечего.
 */
const assistBodySchema = z.object({
  kind: z.string().trim().min(1).max(200),
  message: z.string().trim().min(1).max(50_000),
  fields: z.record(z.string(), z.unknown()).default({}),
  schema: z.record(z.string(), z.string()).default({}),
  history: assistHistorySchema.default([]),
  images: z.unknown().optional(),
});

/** Отказ кривому телу — до модели и до CLI. */
export function invalidAssistBody(error: z.ZodError) {
  const detail = error.issues
    .map((issue) => `${issue.path.join('.') || 'body'}: ${issue.message}`)
    .join('; ');
  return {
    error: 'invalid_body',
    message: `Запрос помощнику не принят: ${detail}`,
    messageCode: 'assistant-request-invalid' as const,
    params: { detail },
  };
}

/**
 * Маршрут помощника. Ответ приходит за секунды, поэтому клиент обязан
 * показывать ожидание — форма при этом остаётся доступной для ручной правки.
 *
 * `/api/assist` — помощник по заполнению форм: лёгкое окно (D4, 28.09) —
 * тело проверяется схемой, история в нём же, секреты полей — маской до модели.
 * Идёт маршрутом активного провайдера (`domains/assistant-route.ts`): профиль
 * «Ассистент панели», иначе Claude по подписке или чужой CLI маршрутом его чата;
 * отказ маршрута — `error` с кодом в ответе 200, как и прочие сбои окна.
 * `/api/assistant/run` — мультимодельный ассистент по активному провайдеру
 * (Ф6b): claude делегирует своему существующему CLI-пути, прочие идут через
 * новые раннеры (cli/api) по switch. Секреты/ключи не логируем.
 */
export function registerAssistantRoutes(
  app: FastifyInstance,
  ctx: ServerContext,
  /** Маршрут провайдера для окна помощника — тот же `runRoute`, что у чатов. */
  helperRoute: HelperRouteWiring,
): void {
  app.post<{ Body: unknown }>('/api/assist', { bodyLimit: ASSIST_BODY_LIMIT }, (request, reply) => {
    const parsed = assistBodySchema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send(invalidAssistBody(parsed.error));
    const images = readAgentImages(parsed.data.images);
    if (!images.ok) return reply.code(400).send(images.refusal);
    // Маршрут решается на КАЖДЫЙ запрос: активный CLI, профиль ассистента и
    // галочки контура меняются на лету, и окно обязано идти тем, что выбрано сейчас.
    const appDataDir = ctx.location.paths.appData;
    return askAssistant(
      { ...parsed.data, images: images.images },
      helperAskFor(ctx.store, appDataDir, helperRoute),
    );
  });

  app.post<{ Body: AssistantRunRequest & { images?: unknown } }>(
    '/api/assistant/run',
    { bodyLimit: ASSIST_BODY_LIMIT },
    async (request, reply) => {
      const images = readAgentImages(request.body?.images);
      if (!images.ok) return reply.code(400).send(images.refusal);
      const messages: AssistantMessage[] = Array.isArray(request.body?.messages)
        ? request.body.messages
            .filter((m) => m && typeof m.content === 'string')
            .map((m) => ({
              role: m.role === 'assistant' ? 'assistant' : 'user',
              content: m.content,
            }))
        : [];
      // Картинки — последней реплике человека: прежние ходы уже отвечены.
      const lastUser = messages.map((m) => m.role).lastIndexOf('user');
      // Картинки без реплики человека приложить не к чему — отказ, а не 200 с
      // молча выброшенными картинками (F-204).
      if (lastUser < 0 && images.images.length > 0) {
        return reply.code(400).send({
          error: 'invalid_images',
          message: 'Картинки в запросе переданы не так, как ждёт панель.',
          messageCode: 'media-agent-images-invalid',
        });
      }
      if (lastUser >= 0 && images.images.length > 0) {
        messages[lastUser] = { ...messages[lastUser]!, images: images.images };
      }
      const provider = getActiveProvider(ctx.store);
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
        // Свой эндпоинт панели, если он выбран в настройках: тогда ассистент идёт
        // по этому адресу, а не в облако вендора и не через подписочный CLI.
        endpoint: resolveAssistantEndpoint(ctx.store, ctx.location.paths.appData),
        // Переключатель Claude на локальную модель — тот же, что у помощника формы.
        ...(helperRoute.claudeSwitchEnv ? { claudeEnv: helperRoute.claudeSwitchEnv } : {}),
      });
      return result satisfies AssistantRunResult;
    },
  );
}
