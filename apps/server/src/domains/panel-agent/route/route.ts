import type { AskFields } from '@agentdeck/contracts/core/ask';
import type { PanelAgentRunRefusalCode } from '@agentdeck/contracts/panel-agent';
import type { AppStore } from '../../../lib/app-store/app-store.ts';
import { getActiveProvider } from '../../../providers/registry.ts';
import { contourRunPrompt } from '../../platform/routing/routing.ts';
import { readPlatforms } from '../../platform/store/store.ts';

/**
 * Чем пойдёт ход агента панели (этап 10, F2, проход 2c) — выбор человека, переведённый в поля
 * вопроса ядра. Запуск, ключ, шлюз и контур — дело ядра: панель называет CLI (активный провайдер)
 * и маршрут профиля «Ассистент панели», ядро судит его тем же судом, что `set-route`
 * (реестр загрузки, обязательный контур), и отказывает с причиной, а не уходит в облако молча.
 *
 * Потребитель контура у агента тот же, что у ассистента панели: выбор живёт в
 * `assistantEndpointId`. Второго переключателя «агент через контур» нет намеренно: две настройки
 * одного маршрута разошлись бы.
 */

export type PanelAgentRoute =
  | {
      ok: true;
      providerId: string;
      fields: Pick<AskFields, 'adapter' | 'routes' | 'model' | 'consumer'>;
      contourId?: string;
      /** Промпт контура (`contourRunPrompt`): без него модель контура назвала бы себя Claude. */
      contourPrompt?: string;
    }
  | { ok: false; code: PanelAgentRunRefusalCode; message: string };

/** Потребитель контура, под которым ядро пишет ход агента (`ask.consumer`). */
const ASSISTANT_CONSUMER = 'assistant';
/** Маршрут контура в реестре ядра: `gateway:<id>` (`routes/gateway/gateway.ts` ядра). */
const gatewayRouteId = (contourId: string): string => `gateway:${contourId}`;
/** Свой адрес человека в реестре ядра: `api-key:endpoint:<id>` (`bootstrap/panel-routes.ts`). */
const endpointRouteId = (profileId: string): string => `api-key:endpoint:${profileId}`;

export function resolvePanelAgentRoute(store: AppStore, appDataDir: string): PanelAgentRoute {
  const provider = getActiveProvider(store);
  const settings = store.getSettings();
  const profile = settings.assistantEndpointId
    ? settings.endpointProfiles.find((item) => item.id === settings.assistantEndpointId)
    : undefined;
  const base = { adapter: provider.id, consumer: ASSISTANT_CONSUMER };
  // Профиля нет — набор запуска ядра: вход CLI или обязательный контур, как у любой сессии.
  if (!profile) return { ok: true, providerId: provider.id, fields: base };
  const model = profile.model?.trim() ? { model: profile.model.trim() } : {};
  if (!profile.ownerPlatformId) {
    // Ключ своего адреса держит хост звеньев ядра — процессу CLI он не отдаётся (09, G5).
    return {
      ok: true,
      providerId: provider.id,
      fields: {
        ...base,
        ...model,
        routes: [
          {
            adapter: provider.id,
            route: { kind: 'api-key', id: endpointRouteId(profile.id) },
            modelPattern: '*',
          },
        ],
      },
    };
  }
  const platformId = profile.ownerPlatformId;
  const platform = readPlatforms(store).find((item) => item.id === platformId);
  const contourPrompt = platform
    ? contourRunPrompt(appDataDir, platform, profile.model).trim()
    : '';
  return {
    ok: true,
    providerId: provider.id,
    contourId: platformId,
    ...(contourPrompt ? { contourPrompt } : {}),
    fields: {
      ...base,
      ...model,
      routes: [
        {
          adapter: provider.id,
          route: { kind: 'gateway', id: gatewayRouteId(platformId) },
          modelPattern: '*',
        },
      ],
    },
  };
}
