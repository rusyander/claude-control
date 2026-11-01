import type { JournalDataV1 } from '@agentdeck/contracts/core/journal';
import type { RouteKind } from '@agentdeck/contracts/core/routes';

/** Разрешённая тройка (переходник, маршрут, шаблон модели) — форма журнала (11 §Policy). */
export type AllowedRoute = JournalDataV1['task.created']['allowedRoutes'][number];

/** Уровни, которые только СУЖАЮТ набор (06 §Precedence): сценарий, файлы проекта, слой человека. */
export type NarrowingLevel = 3 | 4 | 5;

/**
 * Слой уровня 3–5: какие тройки он оставляет. `routes` — список троек (каждая обязана быть
 * внутри текущего набора, иначе это расширение — отказ с именем); `kinds` — «только контур» /
 * «только локальная» видами маршрутов. Оба — пересечение.
 */
export interface RouteNarrowing {
  level: NarrowingLevel;
  /** Кто это сказал: `r1: .agentdeck/scenario.json`. */
  source: string;
  routes?: readonly AllowedRoute[];
  kinds?: readonly RouteKind[];
}

/** Активный контур (уровень 1 — платформа): `required` сводит набор к своему шлюзу. */
export interface ContourPolicy {
  contourId: string;
  mode: 'required' | 'best-effort';
  /** Доступность шлюза; `down` при `required` — отказ, никогда не облако вендора (P118). */
  gateway: 'up' | 'down' | 'unknown';
}

export interface AllowedSetInput {
  /** Выбор человека при запуске или живой командой (уровень 2). */
  launch: readonly AllowedRoute[];
  /** Вход CLI переходника, если такой маршрут настроен (`cli-login:<adapter>`); нет — `undefined`. */
  cliLoginOf: (adapter: string) => AllowedRoute | undefined;
  narrowings: readonly RouteNarrowing[];
  contour?: ContourPolicy;
}

/** Строка «что применено / что отвергнуто» — уровень, путь и причина для экрана запуска. */
export interface AllowedSetEntry {
  level: 1 | 2 | NarrowingLevel;
  path: string;
  reason: string;
}

export type AllowedSetResolution =
  | {
      kind: 'set';
      allowedRoutes: AllowedRoute[];
      /** Уровень источника итогового набора (журнал: `routesSourceLevel`). */
      sourceLevel: number;
      applied: AllowedSetEntry[];
      rejected: AllowedSetEntry[];
    }
  | {
      kind: 'refused';
      /** `route_unavailable` — шлюз обязательного контура лежит; `not_allowed` — сужено в пустоту. */
      code: 'route_unavailable' | 'not_allowed';
      reasons: string[];
      applied: AllowedSetEntry[];
      rejected: AllowedSetEntry[];
    };
