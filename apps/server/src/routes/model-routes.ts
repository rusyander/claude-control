import type { FastifyInstance } from 'fastify';
import type {
  ModelCatalogResponse,
  ModelInfo,
  ModelSource,
  PlatformHealthRecord,
} from '@agentdeck/contracts';
import type { ServerContext } from '../context.ts';
import { getActiveProvider, getProvider } from '../providers/registry.ts';
import { MODELS_URL } from '../domains/models/model-source.ts';
import { MODELS_MAX_AGE_MS } from '../domains/models/model-store.ts';
import { planDefaultPromotion } from '../domains/models/model-defaults.ts';
import { isPlatformCatalogStale, resolvePlatformSource } from '../domains/models/catalog-source.ts';
import { platformModels } from '../domains/models/platform-catalog.ts';
import { checkPlatform } from '../domains/platform/check.ts';
import { findPlatform, readToken } from '../domains/platform/store.ts';

/**
 * Каталог моделей активного провайдера.
 *
 * Источников два, и человек выбирает между ними сам. models.dev — открытый
 * каталог всех вендоров: полный, но про права ключа не знающий. Контур — список
 * КЛЮЧА: короче ровно на то, чего ключу не выдали, и в этом его смысл.
 *
 * Запрос идёт при открытии настроек и при старте панели, но в сеть уходит не
 * чаще раза в сутки — остальное отдаётся из кэша. Ручное обновление (`refresh`)
 * ходит в сеть всегда: кнопка, на которую нажали, обязана делать то, что
 * написано.
 *
 * ЭТОТ МАРШРУТ к контуру сам не ходит никогда — только по кнопке. Правило Т1, и
 * оно строже, чем для models.dev, намеренно: поход в корпоративный контур
 * тратит ключ человека и оставляет след в чужом журнале, а открытие настроек
 * согласием на это не является. Без нажатия каталог контура берётся из следа
 * последней пробы — он переживает и F5, и перезапуск, и обрыв сети.
 *
 * С 18.09.2026 (A-2) у следа появился второй источник — фоновая перепроверка
 * АКТИВНОГО контура по расписанию (`domains/platform/watch.ts`). Правило это не
 * отменяет, а уточняет: с пути запроса панель в контур по-прежнему не ходит,
 * и здесь, на открытии настроек, — тем более. Фоновая проба идёт своим таймером,
 * интервалом из настроек, и помечает запись как фоновую.
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

      const forced = request.query.refresh === 'true';
      const settings = ctx.store.getSettings();
      const requestedSource: ModelSource = settings.modelSource;

      if (requestedSource === 'platform') {
        const answer = await platformCatalog(ctx, provider.id, forced);
        // Контур ответил — отдаём его список. Не ответил — падаем на models.dev,
        // но НАЗЫВАЕМ причину: подменить список того, чем человек может
        // пользоваться, и промолчать об этом нельзя.
        if (answer.catalog) return answer.catalog;
        return devCatalog(ctx, provider, forced, {
          requestedSource,
          fallback: answer.fallback,
          platformId: answer.platformId,
          platformTitle: answer.platformTitle,
        });
      }

      return devCatalog(ctx, provider, forced, { requestedSource });
    },
  );
}

/** Что известно об откате: причина и контур, из-за которого он случился. */
interface FallbackFacts {
  requestedSource: ModelSource;
  fallback?: ModelCatalogResponse['fallback'];
  platformId?: string;
  platformTitle?: string;
}

/**
 * Каталог из контура. Возвращает либо готовый ответ, либо причину отката —
 * решение принимает вызывающий, потому что откат означает ПОХОД В ДРУГОЙ
 * источник, а не пустой список.
 */
async function platformCatalog(
  ctx: ServerContext,
  providerId: string,
  forced: boolean,
): Promise<{
  catalog?: ModelCatalogResponse;
  fallback?: ModelCatalogResponse['fallback'];
  platformId?: string;
  platformTitle?: string;
}> {
  const appData = ctx.location.paths.appData;
  const platformId = ctx.store.getSettings().modelSourcePlatform;
  const platform = platformId ? findPlatform(ctx.store, platformId) : undefined;

  // Кнопка «Обновить» — единственный повод сходить к контуру ОТСЮДА. Проба
  // бесплатна (только список моделей), но след в журнале контура она всё равно
  // оставляет; второй её повод — фоновый таймер, и он живёт не здесь (A-2).
  //
  // Проба отказом не бросается — кроме одного случая: нечитаемый файл
  // корневого сертификата, ошибка НАСТРОЙКИ, а не связи. Выпустить её наружу
  // значит ответить 400 на маршрут, обязанный вернуть каталог: список моделей
  // пропал бы с экрана целиком, и без причины. Ловим и называем причиной
  // отката — прежний список при этом остаётся с models.dev.
  if (forced && platform?.enabled && readToken(appData, platformId)) {
    try {
      await checkPlatform(ctx.store, appData, platformId);
    } catch {
      return { fallback: 'check-failed', platformId, platformTitle: platform.title };
    }
  }

  const decision = resolvePlatformSource({
    platformId,
    platform,
    hasToken: platformId ? Boolean(readToken(appData, platformId)) : false,
    health: platformId ? ctx.store.getPlatformHealth()[platformId] : undefined,
  });

  if (!decision.ok) {
    return {
      fallback: decision.fallback,
      platformId: platformId || undefined,
      platformTitle: decision.platform?.title,
    };
  }

  const health: PlatformHealthRecord = decision.health;
  const models = platformModels(health, decision.platform.id);

  return {
    catalog: {
      provider: providerId,
      // Вендоры контура — это владельцы его моделей: у одного ключа их обычно
      // несколько, и строка «источник» показывает именно их.
      vendors: [...new Set(models.map((model) => model.vendor))].sort(),
      models,
      source: 'platform',
      requestedSource: 'platform',
      platformId: decision.platform.id,
      platformTitle: decision.platform.title,
      // Дата — от последнего УСПЕХА: неудачная проба списка не подтверждала.
      fetchedAt: health.lastOkAt ?? health.checkedAt,
      stale: isPlatformCatalogStale(health, MODELS_MAX_AGE_MS),
      url: health.url,
      unsupported: false,
      newIds: health.newIds ?? [],
      // Автозамены дефолта у контура нет и быть не может: он не публикует ни
      // семейств, ни дат выхода, а «новее» без них — догадка (инвариант 13).
    },
  };
}

/** Каталог из открытого models.dev — прежнее поведение панели, без изменений. */
async function devCatalog(
  ctx: ServerContext,
  provider: { id: string; modelVendors?: string[] },
  forced: boolean,
  facts: FallbackFacts,
): Promise<ModelCatalogResponse> {
  const vendors = provider.modelVendors ?? [];

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
      ...facts,
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
    ...facts,
  };

  promoteDefault(ctx, snapshot.models, response);
  return response;
}

/**
 * Дефолт трогаем только при включённом автообновлении и только когда в
 * настройках стоит модель, которую панель нашла в каталоге: алиас (`opus`) CLI и
 * так разворачивает в последнюю, а незнакомую строку пользователь вписал сам —
 * это не наше дело.
 */
function promoteDefault(
  ctx: ServerContext,
  models: ModelInfo[],
  response: ModelCatalogResponse,
): void {
  const settings = ctx.store.getSettings();
  if (!settings.autoUpdateModels) return;

  const promotion = planDefaultPromotion(models, settings.chatModel, new Date().toISOString());
  if (!promotion) return;

  ctx.store.updateSettings({ chatModel: promotion.to });
  response.promoted = promotion;
}
