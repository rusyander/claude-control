import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AssistantRunRequest, AssistantRunResult } from '@agentdeck/contracts';
import type { ServerContext } from '../../context.ts';
import { askAssistant, coreHelperAsk } from '../../domains/assistant/assistant.ts';
import type {
  AskCarry,
  CoreAskPort,
  OneShotMessage,
} from '../../domains/core-ask/core-ask.types.ts';
import { askMasked, assistantRunResultOf } from '../../domains/core-ask/one-shot.ts';
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
 * Оба маршрута — вопрос ядра «ask» без инструментов активным CLI (этап 10, F2b,
 * `domains/core-ask/one-shot.ts`): профиль «Ассистент панели» и контур судит ядро;
 * отказ — `error` с кодом в ответе 200, как и прочие сбои окна.
 * `/api/assistant/run` — окно ассистента: история реплик одним текстом, секреты
 * под маской до ядра. Секреты/ключи не логируем.
 */
export function registerAssistantRoutes(
  app: FastifyInstance,
  ctx: ServerContext,
  /** Ядро: каждый вопрос окна — его сессия «ask». */
  ask: CoreAskPort,
  /**
   * Набор панели чужому CLI помощника формы (`helperCarryOf`, G13) — только `/api/assist`, как
   * прежнее окно; `/api/assistant/run` набора не получал.
   */
  carry?: AskCarry,
): void {
  app.post<{ Body: unknown }>('/api/assist', { bodyLimit: ASSIST_BODY_LIMIT }, (request, reply) => {
    const parsed = assistBodySchema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send(invalidAssistBody(parsed.error));
    const images = readAgentImages(parsed.data.images);
    if (!images.ok) return reply.code(400).send(images.refusal);
    // Маршрут решается на КАЖДЫЙ запрос: активный CLI, профиль ассистента и
    // галочки контура меняются на лету, и окно обязано идти тем, что выбрано сейчас.
    return askAssistant(
      { ...parsed.data, images: images.images },
      coreHelperAsk(ask, ctx.store, ctx.location.paths.appData, carry),
    );
  });

  app.post<{ Body: AssistantRunRequest & { images?: unknown } }>(
    '/api/assistant/run',
    { bodyLimit: ASSIST_BODY_LIMIT },
    async (request, reply) => {
      const images = readAgentImages(request.body?.images);
      if (!images.ok) return reply.code(400).send(images.refusal);
      const messages: OneShotMessage[] = Array.isArray(request.body?.messages)
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
      // Вся история — одним текстом каждого вопроса: памяти между вопросами у сессии ядра нет,
      // `conversationId` (прежний сессионный режим `opencode serve`) больше ничего не меняет.
      const result = await askMasked(ask, ctx.store, ctx.location.paths.appData, {
        title: 'panel assistant',
        messages,
      });
      return assistantRunResultOf(result) satisfies AssistantRunResult;
    },
  );
}
