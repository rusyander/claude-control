import type { FastifyInstance, FastifyReply } from 'fastify';
import type {
  ProviderKeyResult,
  ProviderKeysResponse,
  ProviderRunnerInfo,
} from '@claude-control/contracts';
import type { ServerContext } from '../context.ts';
import { getActiveProviderId } from '../providers/registry.ts';
import {
  describeActiveRunner,
  describeProviderKeys,
  saveProviderKey,
  deleteProviderKey,
  ProviderKeyError,
} from '../domains/provider-keys.ts';

/**
 * API-ключи провайдеров и резолвинг раннера ассистента (Ф6a).
 *
 * БЕЗОПАСНОСТЬ: секреты не эхоятся. GET отдаёт только маску (`sk-…last4`) и
 * статус; PUT принимает ключ и возвращает маскированный статус, но не сам ключ.
 * Ключ хранится зашифрованно в appData панели (см. `lib/provider-keys.ts`).
 *
 * - `GET /api/provider-keys` — список провайдеров: apiKind, статус ключа
 *   (маскированный, source stored/env/none), стандартные env-переменные.
 * - `PUT /api/provider-keys/:id` — задать ключ провайдера.
 * - `DELETE /api/provider-keys/:id` — очистить ключ провайдера.
 * - `GET /api/provider-runner` — резолв раннера активного провайдера (api/cli/none).
 */
export function registerProviderKeysRoutes(app: FastifyInstance, ctx: ServerContext): void {
  const appDataDir = (): string => ctx.location.paths.appData;

  const sendKeyError = (reply: FastifyReply, error: ProviderKeyError): FastifyReply => {
    const status = error.code === 'unknown_provider' ? 404 : 400;
    return reply.code(status).send({ error: error.code, message: error.message });
  };

  app.get('/api/provider-keys', () => {
    return {
      active: getActiveProviderId(ctx.store),
      items: describeProviderKeys(appDataDir()),
    } satisfies ProviderKeysResponse;
  });

  app.get('/api/provider-runner', () => {
    return describeActiveRunner(ctx.store, appDataDir()) satisfies ProviderRunnerInfo;
  });

  app.put<{ Params: { id: string }; Body: unknown }>('/api/provider-keys/:id', (request, reply) => {
    const body = request.body;
    const key =
      body && typeof body === 'object' && typeof (body as { key?: unknown }).key === 'string'
        ? (body as { key: string }).key
        : '';
    try {
      const keyStatus = saveProviderKey(appDataDir(), request.params.id, key);
      return { ok: true, providerId: request.params.id, keyStatus } satisfies ProviderKeyResult;
    } catch (error) {
      if (error instanceof ProviderKeyError) return sendKeyError(reply, error);
      throw error;
    }
  });

  app.delete<{ Params: { id: string } }>('/api/provider-keys/:id', (request, reply) => {
    try {
      const keyStatus = deleteProviderKey(appDataDir(), request.params.id);
      return { ok: true, providerId: request.params.id, keyStatus } satisfies ProviderKeyResult;
    } catch (error) {
      if (error instanceof ProviderKeyError) return sendKeyError(reply, error);
      throw error;
    }
  });
}
