import type { Fact } from '@agentdeck/contracts/core/facts';
import type {
  ServiceEndpoint,
  ServiceNeed,
  ServiceRecipe,
} from '@agentdeck/contracts/core/records';
import type { EngineHandle } from '../../platform/container-engine.ts';

/** Сервисы проверок (04:124-127): контейнер задачи на рецепт, готовый принимать соединения. */

export interface StartedService {
  recipe: string;
  /** id контейнера движка. */
  engineId: string;
  /** Порт хоста (127.0.0.1), опубликованный на главный порт рецепта. */
  hostPort: number | null;
  endpoint: ServiceEndpoint | null;
  /** Контейнер этой задачи и рецепта уже был (повтор после краха ядра) — второй не запущен. */
  reused: boolean;
}

export interface ServiceStartOptions {
  /** Потолок ожидания готовности; дольше — `unknown`, проверка получает `no-verdict(env)`. */
  readyTimeoutMs?: number;
  pollMs?: number;
  /** Лишние метки (тестовая метка зоны) — к меткам задачи и эфемерности. */
  extraLabels?: Record<string, string>;
}

/**
 * Вход C (план §2): `ensureServices(task, needs)`. Любой не-`value` — проверка с сервисами
 * получает `no-verdict(env)` (P58), причина названа (`engine-absent`, `engine-down`,
 * `recipe-missing`, `not-ready`, `no-endpoint`). Мало места на диске — не причина отсюда: это
 * блокировка очереди по тому дома ядра.
 */
export type EnsureServices = (
  taskId: string,
  needs: readonly ServiceNeed[],
) => Promise<Fact<ServiceEndpoint[]>>;

export interface ServiceIo {
  engine: EngineHandle;
  recipes: readonly ServiceRecipe[];
}
