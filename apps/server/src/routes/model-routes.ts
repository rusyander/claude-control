import type { FastifyInstance } from 'fastify';
import type { ModelCatalogResponse } from '@claude-control/contracts';
import type { ServerContext } from '../context.ts';
import { getActiveProvider, getProvider } from '../providers/registry.ts';
import { MODELS_URL } from '../domains/models/model-source.ts';
import { planDefaultPromotion } from '../domains/models/model-defaults.ts';

/**
 * Каталог моделей активного провайдера.
 *
 * Запрос идёт при открытии настроек и при старте панели, но в сеть уходит не
 * чаще раза в сутки — остальное отдаётся из кэша. Ручное обновление (`refresh`)
 * ходит в сеть всегда: кнопка, на которую нажали, обязана делать то, что
 * написано.
 *
 * Автозамена дефолта живёт здесь же, а не отдельным действием: пользователь
 * просил, чтобы новая модель просто становилась дефолтом, а не ждала, пока он
 * зайдёт и нажмёт. Меняется ровно одна настройка панели, и ответ говорит, что
 * именно поменялось, — молчаливой подмены нет.
 */
export function registerModelRoutes(app: FastifyInstance, ctx: ServerContext): void {
  app.get<{ Querystring: { provider?: string; refresh?: string } }>(
    '/api/models',
    async (request): Promise<ModelCatalogResponse> => {
      const provider = request.query.provider
        ? getProvider(request.query.provider)
        : getActiveProvider(ctx.store);

      const vendors = provider.modelVendors ?? [];
      const forced = request.query.refresh === 'true';

      if (vendors.length === 0) {
        return {
          provider: provider.id,
          vendors: [],
          models: [],
          source: 'none',
          stale: false,
          url: MODELS_URL,
          unsupported: true,
          newIds: [],
        };
      }

      const settings = ctx.store.getSettings();
      // Автообновление выключено — в сеть не ходим вовсе, кроме явной кнопки.
      const snapshot =
        forced || settings.autoUpdateModels
          ? await ctx.models.refresh(vendors, { force: forced })
          : ctx.models.current(vendors);

      const response: ModelCatalogResponse = {
        provider: provider.id,
        vendors,
        models: snapshot.models,
        source: snapshot.fetchedAt ? 'models.dev' : 'none',
        fetchedAt: snapshot.fetchedAt,
        stale: ctx.models.isStale(),
        url: snapshot.url,
        unsupported: false,
        newIds: snapshot.newIds,
      };

      // Дефолт трогаем только при включённом автообновлении и только когда в
      // настройках стоит модель, которую панель нашла в каталоге: алиас
      // (`opus`) CLI и так разворачивает в последнюю, а незнакомую строку
      // пользователь вписал сам — это не наше дело.
      if (settings.autoUpdateModels) {
        const promotion = planDefaultPromotion(
          snapshot.models,
          settings.chatModel,
          new Date().toISOString(),
        );
        if (promotion) {
          ctx.store.updateSettings({ chatModel: promotion.to });
          response.promoted = promotion;
        }
      }

      return response;
    },
  );
}
