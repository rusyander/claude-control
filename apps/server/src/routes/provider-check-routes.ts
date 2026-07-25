import type { FastifyInstance } from 'fastify';
import type {
  ProviderCheckRequest,
  ProviderCheckResult,
  ProviderChecksResponse,
} from '@claude-control/contracts';
import type { ServerContext } from '../context.ts';
import { checkProvider } from '../domains/provider-check.ts';
import { getProvider, isKnownProviderId } from '../providers/registry.ts';

/**
 * Проверка провайдера на реальной машине (IDEA-2) и её сохранённые итоги.
 *
 * `GET /api/providers/checks` — что проверено раньше (бейджи рисуются по нему,
 * без запуска чего-либо). `POST /api/providers/:id/check` — прогнать проверку
 * сейчас; настоящие файлы пользователя при этом не пишутся (круг записи идёт на
 * временной копии, см. `domains/provider-check.ts`).
 *
 * Незнакомый id — 404, а НЕ молчаливый откат на claude: реестр таким откатом
 * защищает работу панели, но здесь он означал бы «проверили не то, что просили»
 * и повесил бы чужой бейдж.
 */
export function registerProviderCheckRoutes(app: FastifyInstance, ctx: ServerContext): void {
  app.get(
    '/api/providers/checks',
    () =>
      ({
        checks: ctx.store.getProviderChecks(),
      }) satisfies ProviderChecksResponse,
  );

  app.post<{ Params: { id: string }; Body: ProviderCheckRequest }>(
    '/api/providers/:id/check',
    async (request, reply) => {
      const { id } = request.params;
      if (!isKnownProviderId(id)) {
        return reply.code(404).send({
          error: 'unknown_provider',
          message: `Провайдер «${id}» неизвестен панели.`,
        });
      }

      const provider = getProvider(id);
      const result = await checkProvider(id, {
        appDataDir: ctx.location.paths.appData,
        claudeDirOverride: ctx.store.getSettings().claudeDirOverride,
        // Ассистента запускаем, если явно не отказались: это платный вызов по
        // ключу/подписке пользователя, но без него проверка неполная.
        withAssistant: request.body?.assistant !== false,
        // Только кэш каталога: проверка не должна ждать сеть ради имени модели.
        models: ctx.models.current(provider.modelVendors ?? []).models,
      });

      ctx.store.saveProviderCheck(result);
      return result satisfies ProviderCheckResult;
    },
  );
}
