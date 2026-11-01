import type { UnknownAction } from '@agentdeck/contracts/core/facts';
import type { Route, RouteId, RouteKind } from '@agentdeck/contracts/core/routes';
import type { AllowedRoute } from './resolve.types.ts';

/** Маршрут, как его видит предпроверка: вид, объявленные действия на `unknown`, чтения. */
export type PreflightRoute = Pick<Route, 'id' | 'kind' | 'facts' | 'read'>;

/** Подбор своей модели под память (P129, `routes/local/own/fit`): мало — запуска нет. */
export type MemoryFit = (
  route: AllowedRoute,
) => Promise<{ short: boolean; detail: string } | undefined>;

export interface RoutePreflightInput {
  /** Тройка, которой задача пойдёт (выбор человека). Альтернативы вместо неё не берутся. */
  chosen: AllowedRoute;
  /** Разрешённый набор задачи (`resolveAllowedRoutes`), из него — альтернативы. */
  allowed: readonly AllowedRoute[];
  /** Реестр маршрутов загрузки; нет маршрута — строка `fail` с исправлением. */
  routeOf: (id: RouteId) => PreflightRoute | undefined;
  /** Память карты для своей модели; не дан — проверка не делалась и названа так. */
  memoryFit?: MemoryFit;
}

/** Одна проверка строки: что прочитано и что из этого следует. */
export interface RouteCheck {
  check: 'registry' | 'availability' | 'credential' | 'memory';
  status: 'ok' | 'fail' | 'unknown' | 'not-checked';
  detail: string;
  /** Действие на `unknown` — объявленное маршрутом для этого факта (P111). */
  onUnknown?: UnknownAction;
}

/**
 * Строка предпроверки маршрута (P128). `fail` — запуска этим маршрутом нет, `fix` называет
 * исправление; `unknown` — прочитать не удалось, `onUnknown` — действие (ждать, идти, отказ).
 */
export interface RoutePreflightRow {
  routeId: RouteId;
  kind: RouteKind | 'unregistered';
  adapter: string;
  modelPattern: string;
  status: 'ok' | 'fail' | 'unknown';
  checks: RouteCheck[];
  fix?: string;
  onUnknown?: UnknownAction;
}

/**
 * Итог по выбранной тройке. `start: false` — запуска нет; `chosen` остаётся выбранной ВСЕГДА:
 * годные альтернативы только перечислены для человека (P128), взять одну может лишь команда
 * уровня 2 (`set-route`). `waits` — доступность неизвестна, единицы ждут в безопасной точке (P77).
 */
export interface RoutePreflightVerdict {
  start: boolean;
  waits: boolean;
  chosen: RoutePreflightRow;
  alternatives: RoutePreflightRow[];
  rows: RoutePreflightRow[];
  /** Текст экрана запуска: причина, исправление, альтернативы — словами. */
  reasons: string[];
}
