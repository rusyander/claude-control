import type { FastifyInstance, FastifyReply } from 'fastify';
import { isPromptId, type PromptId } from '@agentdeck/contracts/prompts';
import type { ServerContext } from '../context.ts';
import { listPrompts, readPromptRecord, resetPrompt, savePrompt } from '../domains/prompts.ts';
import { PromptTooLongError } from '../domains/prompts/errors.ts';
import { codeOf } from '../lib/server-text.ts';

/**
 * Каталог промптов приложения: посмотреть, переписать, вернуть встроенный.
 *
 * Отдельный адрес, а не поле настроек: промпт — это текст на десятки строк, и
 * складывать его в `state.json` вместе с тумблерами значило бы переписывать всё
 * состояние панели при каждом сохранении абзаца. Правки лежат файлами в каталоге
 * данных, и раздел настроек читает их отсюда.
 *
 * Записи ровно две, и обе явные: PUT — правка человека, DELETE — «Сбросить к
 * встроенному». Сброса «пустым текстом» нет намеренно: пустой промпт — это
 * тоже решение (модель получит пустую инструкцию), и путать его с возвратом к
 * репозиторию нельзя.
 */
export function registerPromptRoutes(app: FastifyInstance, ctx: ServerContext): void {
  const appData = (): string => ctx.location.paths.appData;

  const requirePrompt = (id: unknown, reply: FastifyReply): PromptId | undefined => {
    if (!isPromptId(id)) {
      void reply.code(404).send({
        error: 'unknown_prompt',
        message: 'Такого промпта в каталоге нет.',
        messageCode: 'prompt-not-in-catalog',
      });
      return undefined;
    }
    return id;
  };

  app.get('/api/prompts', () => ({ items: listPrompts(appData()) }));

  app.get<{ Params: { id: string } }>('/api/prompts/:id', (request, reply) => {
    const id = requirePrompt(request.params.id, reply);
    return id ? readPromptRecord(appData(), id) : reply;
  });

  app.put<{ Params: { id: string }; Body: { text?: unknown } }>(
    '/api/prompts/:id',
    (request, reply) => {
      const id = requirePrompt(request.params.id, reply);
      if (!id) return reply;

      const text = request.body?.text;
      if (typeof text !== 'string') {
        return reply.code(400).send({
          error: 'invalid_text',
          message: 'Нужен текст промпта.',
          messageCode: 'prompt-text-required',
        });
      }
      try {
        // Потолок держит сам домен (в БАЙТАХ: кириллица весит вдвое, и «64 КБ»
        // по символам пропустили бы 128 КБ в запрос модели). Маршрут только
        // рассказывает об отказе — так же ответит и любой другой писатель.
        return savePrompt(appData(), id, text, undefined, ctx.backupDir);
      } catch (error) {
        if (error instanceof PromptTooLongError) {
          return reply
            .code(400)
            .send({ error: error.code, message: error.message, ...codeOf(error) });
        }
        return reply.code(500).send({
          error: 'save_failed',
          message: error instanceof Error ? error.message : String(error),
          ...codeOf(error),
        });
      }
    },
  );

  app.delete<{ Params: { id: string } }>('/api/prompts/:id', (request, reply) => {
    const id = requirePrompt(request.params.id, reply);
    if (!id) return reply;

    try {
      return resetPrompt(appData(), id, ctx.backupDir);
    } catch (error) {
      return reply.code(500).send({
        error: 'reset_failed',
        message: error instanceof Error ? error.message : String(error),
        ...codeOf(error),
      });
    }
  });
}
