import type { FastifyInstance, FastifyReply } from 'fastify';
import type { ProviderProjectInstructions } from '@claude-control/contracts';
import type { ServerContext } from '../../context.ts';
import {
  readProviderProjectInstructions,
  writeProviderProjectInstructions,
} from '../../domains/provider-projects.ts';
import { UnrecognizedFormatError } from '../../lib/format-errors.ts';
import {
  readProviderInstructionsInfo,
  parseProviderInstructionsDraft,
  saveProviderInstructionsEntries,
  readListedInstructionsFile,
  writeListedInstructionsFile,
  ListedFileNotEditableError,
} from '../../domains/provider-instructions.ts';
import { done } from '../write-result.ts';
import { requireTarget } from './target.ts';
import {
  FORMAT_UNRECOGNIZED,
  INSTRUCTIONS_LIST_UNSUPPORTED,
  INSTRUCTIONS_UNSUPPORTED,
  INVALID_CONTENT,
  INVALID_LIST_DRAFT,
} from './messages.ts';

/** Отказ по одной записи списка: «нет в списке» → 404, прочее (нет файла, бинарь) → 400. */
const sendEntryError = (reply: FastifyReply, error: ListedFileNotEditableError): FastifyReply =>
  reply
    .code(error.reason === 'unlisted' ? 404 : 400)
    .send({ error: error.reason, message: error.message });

/**
 * Инструкции проекта в двух видах: файл в корне (AGENTS.md / GEMINI.md) и список
 * ссылок (`read` в `<проект>/.aider.conf.yml`, AIDER-1).
 *
 * Список ссылок обслуживает тот же домен, что и глобальный раздел; отличие одно —
 * корень проекта задан, поэтому перечисленный файл за его пределами не открывается.
 */
export function registerProviderProjectInstructionsRoutes(
  app: FastifyInstance,
  ctx: ServerContext,
): void {
  app.get<{ Params: { id: string } }>(
    '/api/projects/:id/provider/instructions',
    (request, reply) => {
      const target = requireTarget(ctx, request.params.id, reply);
      if (!target) return reply;
      if (!target.instructions) return reply.code(400).send(INSTRUCTIONS_UNSUPPORTED);

      const { content, exists } = readProviderProjectInstructions(target);
      return {
        content,
        exists,
        fileName: target.instructions.fileName,
        filePath: target.instructions.filePath,
        providerId: target.provider.id,
        providerName: target.provider.name,
      } satisfies ProviderProjectInstructions;
    },
  );

  app.put<{ Params: { id: string }; Body: { content?: unknown } }>(
    '/api/projects/:id/provider/instructions',
    (request, reply) => {
      const target = requireTarget(ctx, request.params.id, reply);
      if (!target) return reply;
      if (!target.instructions) return reply.code(400).send(INSTRUCTIONS_UNSUPPORTED);

      const content = (request.body ?? {}).content;
      // Как и у глобальных инструкций: пустая строка — осознанная очистка, всё
      // нестроковое — отказ, чтобы запрос без поля не затирал файл пустотой.
      if (typeof content !== 'string') return reply.code(400).send(INVALID_CONTENT);

      return done(writeProviderProjectInstructions(target, content, ctx.backupDir));
    },
  );

  app.get<{ Params: { id: string } }>(
    '/api/projects/:id/provider/instructions-list',
    (request, reply) => {
      const target = requireTarget(ctx, request.params.id, reply);
      if (!target) return reply;
      if (!target.instructionsList) return reply.code(400).send(INSTRUCTIONS_LIST_UNSUPPORTED);

      return readProviderInstructionsInfo(target.instructionsList);
    },
  );

  app.put<{ Params: { id: string }; Body: unknown }>(
    '/api/projects/:id/provider/instructions-list',
    (request, reply) => {
      const target = requireTarget(ctx, request.params.id, reply);
      if (!target) return reply;
      if (!target.instructionsList) return reply.code(400).send(INSTRUCTIONS_LIST_UNSUPPORTED);

      const entries = parseProviderInstructionsDraft(request.body);
      if (!entries) return reply.code(400).send(INVALID_LIST_DRAFT);

      try {
        return done(
          saveProviderInstructionsEntries(target.instructionsList, entries, ctx.backupDir),
        );
      } catch (error) {
        if (error instanceof UnrecognizedFormatError)
          return reply.code(422).send(FORMAT_UNRECOGNIZED);
        throw error;
      }
    },
  );

  app.get<{ Params: { id: string }; Querystring: { path?: string } }>(
    '/api/projects/:id/provider/instructions-list/file',
    (request, reply) => {
      const target = requireTarget(ctx, request.params.id, reply);
      if (!target) return reply;
      if (!target.instructionsList) return reply.code(400).send(INSTRUCTIONS_LIST_UNSUPPORTED);

      const raw = request.query.path;
      if (typeof raw !== 'string' || !raw) return reply.code(400).send(INVALID_LIST_DRAFT);

      try {
        return readListedInstructionsFile(target.instructionsList, raw);
      } catch (error) {
        if (error instanceof ListedFileNotEditableError) return sendEntryError(reply, error);
        if (error instanceof UnrecognizedFormatError)
          return reply.code(422).send(FORMAT_UNRECOGNIZED);
        throw error;
      }
    },
  );

  app.put<{ Params: { id: string }; Body: { path?: unknown; content?: unknown } }>(
    '/api/projects/:id/provider/instructions-list/file',
    (request, reply) => {
      const target = requireTarget(ctx, request.params.id, reply);
      if (!target) return reply;
      if (!target.instructionsList) return reply.code(400).send(INSTRUCTIONS_LIST_UNSUPPORTED);

      const body = request.body ?? {};
      const raw = body.path;
      const content = body.content;
      if (typeof raw !== 'string' || !raw) return reply.code(400).send(INVALID_LIST_DRAFT);
      if (typeof content !== 'string') return reply.code(400).send(INVALID_CONTENT);

      try {
        return done(
          writeListedInstructionsFile(target.instructionsList, raw, content, ctx.backupDir),
        );
      } catch (error) {
        if (error instanceof ListedFileNotEditableError) return sendEntryError(reply, error);
        if (error instanceof UnrecognizedFormatError)
          return reply.code(422).send(FORMAT_UNRECOGNIZED);
        throw error;
      }
    },
  );
}
