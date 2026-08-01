import type { FastifyInstance, FastifyReply } from 'fastify';
import type { EnvVar } from '@claude-control/contracts';
import type { ServerContext } from '../../context.ts';
import { SecretBackupUnavailableError } from '../../lib/safe-io.ts';
import {
  readEnvVars,
  revealEnvValue,
  saveEnvVar,
  deleteEnvVar,
  moveEnvVar,
} from '../../domains/env.ts';
import { done } from '../write-result.ts';
import type { ClaudePaths } from './shared.ts';

/** Переменные окружения: settings.json, settings.local.json и файл секретов. */
export function registerEnvRoutes(app: FastifyInstance, ctx: ServerContext): void {
  const paths = (): ClaudePaths => ctx.location.paths;

  app.get('/api/env', () =>
    readEnvVars(paths().settings, paths().secretsEnv, paths().settingsLocal),
  );

  app.get<{ Querystring: { key: string; source: EnvVar['source'] } }>(
    '/api/env/reveal',
    (request) =>
      revealEnvValue(
        paths().settings,
        paths().secretsEnv,
        request.query.key,
        request.query.source,
        paths().settingsLocal,
      ),
  );

  /**
   * Правка секрета без возможной резервной копии — отказ, но ВНЯТНЫЙ: 409 с
   * причиной и подсказкой, а не 500. Причина одна и та же у записи и удаления:
   * шифрование копий включено, а парольной фразы в памяти нет (обычное дело
   * после перезапуска сервера), и писать копию открытым текстом нельзя.
   */
  const withSecretBackupGuard = <T>(reply: FastifyReply, run: () => T): T | FastifyReply => {
    try {
      return run();
    } catch (error) {
      if (error instanceof SecretBackupUnavailableError) {
        return reply.code(409).send({ error: 'secret_backup_unavailable', message: error.message });
      }
      throw error;
    }
  };

  app.post<{ Body: Parameters<typeof saveEnvVar>[2] }>('/api/env', (request, reply) =>
    withSecretBackupGuard(reply, () =>
      done(
        saveEnvVar(
          paths().settings,
          paths().secretsEnv,
          request.body,
          ctx.backupDir,
          paths().settingsLocal,
        ),
      ),
    ),
  );

  app.delete<{ Querystring: { key: string; source: EnvVar['source'] } }>(
    '/api/env',
    (request, reply) =>
      withSecretBackupGuard(reply, () =>
        done(
          deleteEnvVar(
            paths().settings,
            paths().secretsEnv,
            request.query.key,
            request.query.source,
            ctx.backupDir,
            paths().settingsLocal,
          ),
        ),
      ),
  );

  // Перенос переменной между settings.json и settings.local.json. Секреты из
  // .mcp-secrets.env и env групп так не переносятся — их природа иная: отвечаем
  // 400, кнопки для них в интерфейсе нет.
  app.post<{ Params: { key: string }; Body: { source: EnvVar['source'] } }>(
    '/api/env/:key/move',
    (request, reply) => {
      const { source } = request.body;
      if (source !== 'settings' && source !== 'settings-local') {
        return reply.code(400).send({
          error: 'not_movable',
          message: 'Переносить можно только переменные из settings.json / settings.local.json.',
        });
      }

      return done(
        moveEnvVar(
          paths().settings,
          paths().secretsEnv,
          request.params.key,
          source,
          ctx.backupDir,
          paths().settingsLocal,
        ),
      );
    },
  );
}
