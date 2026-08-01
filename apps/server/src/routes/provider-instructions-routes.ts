import type { FastifyInstance, FastifyReply } from 'fastify';
import type { ServerContext } from '../context.ts';
import {
  resolveProviderInstructionsTarget,
  readProviderInstructionsInfo,
  parseProviderInstructionsDraft,
  saveProviderInstructionsEntries,
  readListedInstructionsFile,
  writeListedInstructionsFile,
  ListedFileNotEditableError,
  type ProviderInstructionsTarget,
} from '../domains/provider-instructions.ts';
import { UnrecognizedFormatError } from '../lib/format-errors.ts';
import { done } from './write-result.ts';

/**
 * Раздел инструкций в модели СПИСКА ССЫЛОК (AIDER-1) — глобальный уровень.
 *
 * Claude/Codex/Gemini/OpenCode сюда НЕ ходят: у них инструкции это один файл, и
 * их обслуживает прежний маршрут `/api/claude-md` (регресс-ноль). Здесь —
 * провайдер, у которого единого файла нет и инструкции подключаются списком
 * (`read` в `.aider.conf.yml`).
 *
 * Fail-closed: провайдер без `instructionsList` → 400 `section_unsupported`;
 * конфиг не разбирается / `read` неожиданной формы → чтение `readOnly:true`,
 * запись 422; правка содержимого возможна ТОЛЬКО у записи, которая есть в
 * списке и чей файл существует и текстовый — иначе 400/404 с объяснением.
 * Файлов панель не создаёт.
 */
export function registerProviderInstructionsRoutes(app: FastifyInstance, ctx: ServerContext): void {
  const SECTION_UNSUPPORTED = {
    error: 'section_unsupported',
    message: 'У активного провайдера инструкции не устроены списком ссылок.',
  } as const;

  const INVALID_DRAFT = {
    error: 'invalid_draft',
    message:
      'Список файлов не прошёл проверку: каждая запись должна быть непустой строкой без переводов строк.',
  } as const;

  const FORMAT_UNRECOGNIZED = {
    error: 'format_unrecognized',
    message:
      'Формат файла конфигурации не распознан — запись запрещена (раздел только для чтения).',
  } as const;

  const requireTarget = (reply: FastifyReply): ProviderInstructionsTarget | undefined => {
    const target = resolveProviderInstructionsTarget(ctx.store);
    if (!target) {
      void reply.code(400).send(SECTION_UNSUPPORTED);
      return undefined;
    }
    return target;
  };

  /** Отказ по одной записи: «нет в списке» → 404, прочее (нет файла, бинарь) → 400. */
  const sendEntryError = (reply: FastifyReply, error: ListedFileNotEditableError): FastifyReply =>
    reply
      .code(error.reason === 'unlisted' ? 404 : 400)
      .send({ error: error.reason, message: error.message });

  app.get('/api/provider-instructions', (_request, reply) => {
    const target = requireTarget(reply);
    if (!target) return reply;
    return readProviderInstructionsInfo(target);
  });

  app.put<{ Body: unknown }>('/api/provider-instructions', (request, reply) => {
    const target = requireTarget(reply);
    if (!target) return reply;

    const entries = parseProviderInstructionsDraft(request.body);
    if (!entries) return reply.code(400).send(INVALID_DRAFT);

    try {
      return done(saveProviderInstructionsEntries(target, entries, ctx.backupDir));
    } catch (error) {
      if (error instanceof UnrecognizedFormatError)
        return reply.code(422).send(FORMAT_UNRECOGNIZED);
      throw error;
    }
  });

  // --- Содержимое ОДНОГО перечисленного файла --------------------------------

  app.get<{ Querystring: { path?: string } }>(
    '/api/provider-instructions/file',
    (request, reply) => {
      const target = requireTarget(reply);
      if (!target) return reply;

      const raw = request.query.path;
      if (typeof raw !== 'string' || !raw) return reply.code(400).send(INVALID_DRAFT);

      try {
        return readListedInstructionsFile(target, raw);
      } catch (error) {
        if (error instanceof ListedFileNotEditableError) return sendEntryError(reply, error);
        if (error instanceof UnrecognizedFormatError)
          return reply.code(422).send(FORMAT_UNRECOGNIZED);
        throw error;
      }
    },
  );

  app.put<{ Body: { path?: unknown; content?: unknown } }>(
    '/api/provider-instructions/file',
    (request, reply) => {
      const target = requireTarget(reply);
      if (!target) return reply;

      const body = request.body ?? {};
      const raw = body.path;
      const content = body.content;
      if (typeof raw !== 'string' || !raw) return reply.code(400).send(INVALID_DRAFT);
      // Пустая строка — осознанная очистка файла; всё нестроковое отклоняем,
      // чтобы запрос без поля не затирал файл пустотой.
      if (typeof content !== 'string') {
        return reply.code(400).send({
          error: 'invalid_content',
          message: 'Поле content обязано быть строкой (пустая строка допустима).',
        });
      }

      try {
        return done(writeListedInstructionsFile(target, raw, content, ctx.backupDir));
      } catch (error) {
        if (error instanceof ListedFileNotEditableError) return sendEntryError(reply, error);
        if (error instanceof UnrecognizedFormatError)
          return reply.code(422).send(FORMAT_UNRECOGNIZED);
        throw error;
      }
    },
  );
}
