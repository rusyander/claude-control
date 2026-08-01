import type { FastifyInstance } from 'fastify';
import type { ServerContext } from '../../context.ts';
import {
  readProviderEnvVars,
  saveProviderEnvVars,
  parseProviderEnvDraft,
  EnvKeyNotEncodableError,
  EnvKeyPreservedError,
} from '../../domains/provider-env.ts';
import { UnrecognizedFormatError } from '../../lib/format-errors.ts';
import { done } from '../write-result.ts';
import { requireTarget } from './target.ts';
import { ENV_UNSUPPORTED, FORMAT_UNRECOGNIZED, INVALID_ENV_DRAFT } from './messages.ts';

/** Переменные окружения проекта: тот же адаптер, что и глобально, файл в проекте. */
export function registerProviderProjectEnvRoutes(app: FastifyInstance, ctx: ServerContext): void {
  app.get<{ Params: { id: string } }>('/api/projects/:id/provider/env', (request, reply) => {
    const target = requireTarget(ctx, request.params.id, reply);
    if (!target) return reply;
    if (!target.env) return reply.code(400).send(ENV_UNSUPPORTED);

    const base = {
      providerId: target.provider.id,
      providerName: target.provider.name,
      format: target.env.format,
      filePath: target.env.filePath,
      cliDetected: target.env.cliDetected,
    };

    try {
      return { ...base, vars: readProviderEnvVars(target.env), readOnly: false };
    } catch (error) {
      // Формат не распознан — отдаём раздел на чтение (пустой список) с пометкой.
      if (error instanceof UnrecognizedFormatError) {
        return { ...base, vars: [], readOnly: true, error: error.message };
      }
      throw error;
    }
  });

  app.put<{ Params: { id: string }; Body: unknown }>(
    '/api/projects/:id/provider/env',
    (request, reply) => {
      const target = requireTarget(ctx, request.params.id, reply);
      if (!target) return reply;
      if (!target.env) return reply.code(400).send(ENV_UNSUPPORTED);

      const vars = parseProviderEnvDraft(request.body);
      if (!vars) return reply.code(400).send(INVALID_ENV_DRAFT);

      try {
        return done(saveProviderEnvVars(target.env, vars, ctx.backupDir));
      } catch (error) {
        // Имя переменной непредставимо в формате провайдера — ошибка ввода (400),
        // а не сломанный файл: сообщение объясняет, что именно не так.
        if (error instanceof EnvKeyNotEncodableError) {
          return reply.code(400).send({ error: 'invalid_draft', message: error.message });
        }
        // Имя занято немоделируемой записью файла — конфликт одного ключа (409),
        // а не сломанный формат: файл проекта разобран, править нужно одну
        // переменную. Общий 422 объявлял исправный config.toml нечитаемым.
        if (error instanceof EnvKeyPreservedError) {
          return reply.code(409).send({ error: 'env_key_preserved', message: error.message });
        }
        if (error instanceof UnrecognizedFormatError)
          return reply.code(422).send(FORMAT_UNRECOGNIZED);
        throw error;
      }
    },
  );
}
