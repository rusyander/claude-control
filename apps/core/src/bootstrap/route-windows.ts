import type { Fact } from '@agentdeck/contracts/core/facts';
import type { Route } from '@agentdeck/contracts/core/routes';

/**
 * Окно контекста маршрута × модели — ОДИН источник на ядро (этап 8): его читают и предикат роста
 * контекста наблюдателя (`PredicateCtx.windowOf`), и правило 60 % продолжения
 * (`continuationFacts.windowTokens`). Факт — `route.read.context(model)` (01 §Facts); чтение
 * асинхронное, судьи синхронные, поэтому книга отвечает прочитанным, а первое обращение к паре
 * запускает чтение и отвечает `null` (судить не с чем — недосрабатывание, не ложное).
 * `absent`/`unknown` (вход CLI: окно модели ядро не знает) — `null`, и тогда оба судьи берут окно,
 * названное самой сессией (`turn.usage.contextWindow`); `unknown` перечитывается не чаще
 * `retryMs`, `absent` — так же (маршрут мог подняться).
 *
 * Та же книга держит список моделей маршрута (`route.read.models`) для суда `tier`: вариант клика
 * `model:<id>` у ждущей задачи предлагается, только если маршрут эту модель обслуживает (этап 12,
 * W1-D) — иначе клик упирался в отказ `compat` `model_absent` и сжигал попытки шага.
 */

export interface RouteWindows {
  /** Окно в токенах; `null` — неизвестно (ещё не прочитано, маршрута нет, факт не дан). */
  windowOf(routeId: string, model: string | null): number | null;
  /** Модели маршрута; `null` — неизвестно (ещё не прочитано, маршрута нет, факт не дан). */
  modelsOf(routeId: string): readonly string[] | null;
  /** Дочитать все начатые чтения (проверки, остановка). */
  settled(): Promise<void>;
}

export interface RouteWindowsDeps {
  routeOf(id: string): Pick<Route, 'read'> | undefined;
  /** Монотонное время, мс (повтор чтения). */
  now: () => number;
  note?: (event: string, data: Record<string, unknown>) => void;
  retryMs?: number;
}

export const WINDOW_RETRY_MS = 60_000;

type Slot<T> = { value: T } | { missing: string; at: number } | { reading: Promise<void> };

/** Прочитанное значение факта или причина, почему судить не с чем. */
type Got<T> = { value: T } | { missing: string };

interface Shelf<T> {
  get(
    key: string,
    routeId: string,
    load: (route: Pick<Route, 'read'>) => Promise<Got<T>>,
  ): T | null;
  readings(): Promise<void>[];
}

function shelfOf<T>(
  deps: RouteWindowsDeps,
  retryMs: number,
  unknownEvent: string,
  extra: Record<string, unknown> = {},
): Shelf<T> {
  const slots = new Map<string, Slot<T>>();

  const read = (
    key: string,
    routeId: string,
    load: (route: Pick<Route, 'read'>) => Promise<Got<T>>,
    data: Record<string, unknown>,
  ): void => {
    const route = deps.routeOf(routeId);
    if (!route) {
      slots.set(key, { missing: 'route not in the registry', at: deps.now() });
      return;
    }
    const miss = (why: string): void => {
      slots.set(key, { missing: why, at: deps.now() });
      deps.note?.(unknownEvent, { routeId, ...data, reason: why });
    };
    // Тело — после записи слота `reading`: синхронный бросок чтения иначе записал бы итог
    // раньше, и `reading` затёр бы его навсегда (пара осталась бы «читается» без повтора).
    const reading = Promise.resolve().then(async () => {
      try {
        const got = await load(route);
        if ('value' in got) slots.set(key, { value: got.value });
        else miss(got.missing);
      } catch (error) {
        miss(error instanceof Error ? error.message : String(error));
      }
    });
    slots.set(key, { reading });
  };

  return {
    get(key, routeId, load) {
      const slot = slots.get(key);
      if (slot && 'value' in slot) return slot.value;
      if (slot && 'reading' in slot) return null;
      if (slot && deps.now() - slot.at < retryMs) return null;
      read(key, routeId, load, extra);
      const now = slots.get(key);
      return now && 'value' in now ? now.value : null;
    },
    readings: () => [...slots.values()].flatMap((s) => ('reading' in s ? [s.reading] : [])),
  };
}

/** Причина пустого факта словами: `unknown` несёт свою, `absent` — «нет». */
const missingOf = (got: Fact<unknown>): string => ('unknown' in got ? got.unknown : 'absent');

export function createRouteWindows(deps: RouteWindowsDeps): RouteWindows {
  const retryMs = deps.retryMs ?? WINDOW_RETRY_MS;
  const windows = new Map<string, Shelf<number>>();
  const models = shelfOf<readonly string[]>(deps, retryMs, 'route.models.unknown');

  return {
    windowOf(routeId, model) {
      if (model === null) return null;
      let shelf = windows.get(model);
      if (!shelf) {
        shelf = shelfOf<number>(deps, retryMs, 'route.window.unknown', { model });
        windows.set(model, shelf);
      }
      return shelf.get(routeId, routeId, async (route) => {
        const got = await route.read.context(model);
        if ('value' in got) {
          return Number.isFinite(got.value) && got.value > 0
            ? { value: got.value }
            : { missing: 'not a window' };
        }
        return { missing: missingOf(got) };
      });
    },
    modelsOf(routeId) {
      return models.get(routeId, routeId, async (route) => {
        const got = await route.read.models();
        return 'value' in got ? { value: got.value.map((m) => m.id) } : { missing: missingOf(got) };
      });
    },
    async settled() {
      await Promise.all([
        ...[...windows.values()].flatMap((s) => s.readings()),
        ...models.readings(),
      ]);
    },
  };
}
