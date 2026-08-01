import type { FastifyInstance } from 'fastify';
import type { ProviderPreviewRequest, ProviderPreviewResponse } from '@claude-control/contracts';
import type { ServerContext } from '../context.ts';
import {
  previewProviderWrite,
  SectionUnsupportedError,
  InvalidDraftError,
} from '../domains/provider-preview.ts';
import { McpServerExistsError } from '../domains/provider-mcp.ts';
import { UnrecognizedFormatError } from '../lib/format-errors.ts';

/**
 * Предпросмотр записи в конфигурацию активного провайдера.
 *
 * Отдельный маршрут, а не флаг `?preview` на маршрутах записи: смешивать «покажи»
 * и «запиши» в одном обработчике опасно — однажды забытый флаг означал бы запись
 * там, где её не ждали. Здесь записи нет ни в одной ветке by design (работа идёт
 * по временной копии), поэтому это `POST` без побочных эффектов.
 *
 * Коды ответов те же, что у настоящей записи, — чтобы предпросмотр не оказался
 * добрее её: раздел не поддержан → 400, черновик не прошёл → 400, формат файла
 * не распознан → 422, имя MCP-сервера занято → 409.
 */
export function registerProviderPreviewRoutes(app: FastifyInstance, ctx: ServerContext): void {
  app.post<{ Body: ProviderPreviewRequest }>('/api/provider-preview', (request, reply) => {
    try {
      return previewProviderWrite(ctx.store, request.body) satisfies ProviderPreviewResponse;
    } catch (error) {
      if (error instanceof SectionUnsupportedError)
        return reply.code(400).send({ error: 'section_unsupported', message: error.message });
      if (error instanceof InvalidDraftError)
        return reply.code(400).send({ error: 'invalid_draft', message: error.message });
      // Имя занято: настоящая запись отвечает конфликтом — предпросмотр тоже,
      // иначе он показывал бы дифф операции, которую сохранить всё равно нельзя.
      if (error instanceof McpServerExistsError)
        return reply.code(409).send({ error: 'server_exists', message: error.message });
      if (error instanceof UnrecognizedFormatError)
        return reply.code(422).send({ error: 'format_unrecognized', message: error.message });
      throw error;
    }
  });
}
