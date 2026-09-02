import type { FastifyInstance, FastifyReply } from 'fastify';
import type { ServerContext } from '../../context.ts';
import { SecretBackupUnavailableError } from '../../lib/safe-io.ts';
import {
  EnvVarExistsError,
  EnvVarNotFoundError,
  InvalidEnvDraftError,
  markGroupEnv,
  readEnvVars,
  revealEnvValue,
  saveEnvVar,
  deleteEnvVar,
  moveEnvVar,
} from '../../domains/env.ts';
import { done } from '../write-result.ts';
import type { ClaudePaths } from './shared.ts';

/** Ключ и источник из строки запроса — проверяет домен, здесь они «как пришли». */
interface EnvRefQuery {
  key?: string;
  source?: string;
}

/** Переменные окружения: settings.json, settings.local.json и файл секретов. */
export function registerEnvRoutes(app: FastifyInstance, ctx: ServerContext): void {
  const paths = (): ClaudePaths => ctx.location.paths;

  /**
   * Ошибка домена → статус с причиной, а не 500 и не пустой «ok». Черновик не по
   * правилу — 400; переменной нет — 404 (и файл не переписан); в приёмнике уже
   * есть такой ключ — 409. Отдельный 409 у секрета без возможной резервной копии:
   * шифрование копий включено, а парольной фразы в памяти нет (обычное дело после
   * перезапуска сервера), и писать копию открытым текстом нельзя.
   */
  const guard = <T>(reply: FastifyReply, run: () => T): T | FastifyReply => {
    try {
      return run();
    } catch (error) {
      if (error instanceof InvalidEnvDraftError) {
        return reply.code(400).send({ error: 'invalid_env_draft', message: error.message });
      }
      if (error instanceof EnvVarNotFoundError) {
        return reply.code(404).send({ error: 'env_not_found', message: error.message });
      }
      if (error instanceof EnvVarExistsError) {
        return reply.code(409).send({ error: 'env_exists', message: error.message });
      }
      if (error instanceof SecretBackupUnavailableError) {
        return reply.code(409).send({ error: 'secret_backup_unavailable', message: error.message });
      }
      throw error;
    }
  };

  // Ключи включённых групп уходят с source `group` — их хозяин не файл, а группа.
  app.get('/api/env', () =>
    markGroupEnv(
      readEnvVars(paths().settings, paths().secretsEnv, paths().settingsLocal),
      ctx.store.getGroups(),
    ),
  );

  // Полное значение строкой как есть (text/plain): клиент читает тело сырым, без
  // разбора JSON, иначе числовой секрет приезжал бы числом.
  app.get<{ Querystring: EnvRefQuery }>('/api/env/reveal', (request, reply) =>
    guard(reply, () =>
      revealEnvValue(
        paths().settings,
        paths().secretsEnv,
        request.query.key ?? '',
        request.query.source,
        paths().settingsLocal,
      ),
    ),
  );

  app.post<{ Body: unknown }>('/api/env', (request, reply) =>
    guard(reply, () =>
      done(
        saveEnvVar(
          paths().settings,
          paths().secretsEnv,
          // Форму тела проверяет saveEnvVar (assertEnvDraft) — маршрут не дублирует правило.
          request.body as Parameters<typeof saveEnvVar>[2],
          ctx.backupDir,
          paths().settingsLocal,
        ),
      ),
    ),
  );

  app.delete<{ Querystring: EnvRefQuery }>('/api/env', (request, reply) =>
    guard(reply, () =>
      done(
        deleteEnvVar(
          paths().settings,
          paths().secretsEnv,
          request.query.key ?? '',
          request.query.source,
          ctx.backupDir,
          paths().settingsLocal,
        ),
      ),
    ),
  );

  // Перенос переменной между settings.json и settings.local.json. Секреты из
  // .mcp-secrets.env и env групп так не переносятся — их природа иная: отвечаем
  // своим кодом 400, кнопки для них в интерфейсе нет.
  app.post<{ Params: { key: string }; Body: { source?: string } | undefined }>(
    '/api/env/:key/move',
    (request, reply) => {
      const source = request.body?.source;
      if (source !== 'settings' && source !== 'settings-local') {
        return reply.code(400).send({
          error: 'not_movable',
          message: 'Переносить можно только переменные из settings.json / settings.local.json.',
        });
      }

      return guard(reply, () =>
        done(
          moveEnvVar(
            paths().settings,
            paths().secretsEnv,
            request.params.key,
            source,
            ctx.backupDir,
            paths().settingsLocal,
          ),
        ),
      );
    },
  );
}
