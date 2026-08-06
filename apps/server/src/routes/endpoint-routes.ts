import type { FastifyInstance, FastifyReply } from 'fastify';
import type {
  EndpointApplyResult,
  EndpointProbeResult,
  EndpointsInfo,
} from '@claude-control/contracts';
import type { ServerContext } from '../context.ts';
import {
  applyEndpointProfile,
  clearEndpointToken,
  describeEndpoints,
  EndpointApplyError,
  probeEndpoint,
  readEndpointToken,
  saveEndpointToken,
} from '../domains/endpoints.ts';
import { UnrecognizedFormatError } from '../lib/format-errors.ts';
import { EnvKeyNotEncodableError, EnvKeyPreservedError } from '../domains/provider-env.ts';

/**
 * Свой эндпоинт: профили адреса модели, проверка связи и применение профиля к
 * конфигурации выбранного CLI.
 *
 * Сами ПРОФИЛИ живут в настройках панели и правятся общим `PATCH /api/settings`
 * — отдельного CRUD здесь нет намеренно: это те же настройки, и второй путь их
 * записи означал бы вторую проверку и второй шанс разойтись.
 *
 * БЕЗОПАСНОСТЬ: токен наружу не возвращается никогда — ни в сводке (там маска),
 * ни в ответе применения (там тоже маска), ни в адресе проверки связи (у Google
 * ключ уходит в квери, и наружу отдаётся адрес без него).
 *
 * - `GET /api/endpoints` — профили, маски токенов, готовность каждого CLI.
 * - `PUT /api/endpoints/:id/token` — сохранить токен профиля (зашифрованно).
 * - `DELETE /api/endpoints/:id/token` — забыть токен профиля.
 * - `POST /api/endpoints/:id/probe` — проверка связи: список моделей с адреса.
 * - `POST /api/endpoints/:id/apply` — записать профиль в конфигурацию CLI.
 */
export function registerEndpointRoutes(app: FastifyInstance, ctx: ServerContext): void {
  const appDataDir = (): string => ctx.location.paths.appData;

  const PROFILE_NOT_FOUND = {
    error: 'profile_not_found',
    message: 'Профиль своего эндпоинта не найден.',
  } as const;

  const requireProfile = (reply: FastifyReply, id: string) => {
    const profiles = ctx.store.getSettings().endpointProfiles;
    // Точное совпадение, без падения на первый профиль: применять чужой профиль
    // вместо запрошенного нельзя — это запись в конфигурацию.
    const profile = profiles.find((item) => item.id === id);
    if (!profile) {
      void reply.code(404).send(PROFILE_NOT_FOUND);
      return undefined;
    }
    return profile;
  };

  app.get<{ Querystring: { profile?: string } }>('/api/endpoints', (request) => {
    return describeEndpoints(
      ctx.store,
      appDataDir(),
      ctx.location.paths.settings,
      request.query.profile,
    ) satisfies EndpointsInfo;
  });

  app.put<{ Params: { id: string }; Body: unknown }>(
    '/api/endpoints/:id/token',
    (request, reply) => {
      const profile = requireProfile(reply, request.params.id);
      if (!profile) return reply;

      const body = request.body;
      const value =
        body && typeof body === 'object' && typeof (body as { token?: unknown }).token === 'string'
          ? (body as { token: string }).token
          : '';

      if (!saveEndpointToken(appDataDir(), profile.id, value)) {
        return reply
          .code(400)
          .send({ error: 'invalid_token', message: 'Значение превышает допустимую длину.' });
      }
      return { ok: true };
    },
  );

  app.delete<{ Params: { id: string } }>('/api/endpoints/:id/token', (request, reply) => {
    const profile = requireProfile(reply, request.params.id);
    if (!profile) return reply;
    clearEndpointToken(appDataDir(), profile.id);
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>('/api/endpoints/:id/probe', async (request, reply) => {
    const profile = requireProfile(reply, request.params.id);
    if (!profile) return reply;

    // Отдельный маршрут, а не часть GET: проверка ходит в сеть, а сводка
    // раздела открывается при каждом заходе в настройки.
    return (await probeEndpoint(
      profile,
      readEndpointToken(appDataDir(), profile.id),
    )) satisfies EndpointProbeResult;
  });

  app.post<{ Params: { id: string }; Body: unknown }>(
    '/api/endpoints/:id/apply',
    (request, reply) => {
      const profile = requireProfile(reply, request.params.id);
      if (!profile) return reply;

      const body = request.body;
      const providerId =
        body &&
        typeof body === 'object' &&
        typeof (body as { provider?: unknown }).provider === 'string'
          ? (body as { provider: string }).provider
          : '';

      try {
        return applyEndpointProfile(
          profile,
          providerId,
          readEndpointToken(appDataDir(), profile.id),
          {
            claudeSettings: ctx.location.paths.settings,
            override: ctx.store.getSettings().claudeDirOverride,
          },
          ctx.backupDir,
        ) satisfies EndpointApplyResult;
      } catch (error) {
        if (error instanceof EndpointApplyError) {
          const status = error.code === 'unknown_provider' ? 404 : 400;
          return reply.code(status).send({ error: error.code, message: error.message });
        }
        // Чужой конфиг оказался в непонятном формате или занял имя переменной
        // немоделируемой записью — те же отказы, что и у обычного раздела env,
        // и с теми же кодами: раздел один и тот же файл.
        if (error instanceof EnvKeyNotEncodableError) {
          return reply.code(400).send({ error: 'invalid_draft', message: error.message });
        }
        if (error instanceof EnvKeyPreservedError) {
          return reply.code(409).send({ error: 'env_key_preserved', message: error.message });
        }
        if (error instanceof UnrecognizedFormatError) {
          return reply.code(422).send({
            error: 'format_unrecognized',
            message:
              'Формат файла конфигурации не распознан — запись запрещена (раздел только для чтения).',
          });
        }
        throw error;
      }
    },
  );
}
