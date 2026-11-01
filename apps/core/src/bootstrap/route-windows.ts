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
 */

export interface RouteWindows {
  /** Окно в токенах; `null` — неизвестно (ещё не прочитано, маршрута нет, факт не дан). */
  windowOf(routeId: string, model: string | null): number | null;
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

type Slot = { value: number } | { missing: string; at: number } | { reading: Promise<void> };

export function createRouteWindows(deps: RouteWindowsDeps): RouteWindows {
  const retryMs = deps.retryMs ?? WINDOW_RETRY_MS;
  const slots = new Map<string, Slot>();

  const read = (key: string, routeId: string, model: string): void => {
    const route = deps.routeOf(routeId);
    if (!route) {
      slots.set(key, { missing: 'route not in the registry', at: deps.now() });
      return;
    }
    // Тело — после записи слота `reading`: синхронный бросок `context()` иначе записал бы итог
    // раньше, и `reading` затёр бы его навсегда (пара осталась бы «читается» без повтора).
    const reading = Promise.resolve().then(async () => {
      try {
        const got = await route.read.context(model);
        if ('value' in got && Number.isFinite(got.value) && got.value > 0) {
          slots.set(key, { value: got.value });
          return;
        }
        const why = 'unknown' in got ? got.unknown : 'value' in got ? 'not a window' : 'absent';
        slots.set(key, { missing: why, at: deps.now() });
        deps.note?.('route.window.unknown', { routeId, model, reason: why });
      } catch (error) {
        const why = error instanceof Error ? error.message : String(error);
        slots.set(key, { missing: why, at: deps.now() });
        deps.note?.('route.window.unknown', { routeId, model, reason: why });
      }
    });
    slots.set(key, { reading });
  };

  return {
    windowOf(routeId, model) {
      if (model === null) return null;
      const key = `${routeId}\u0000${model}`;
      const slot = slots.get(key);
      if (slot && 'value' in slot) return slot.value;
      if (slot && 'reading' in slot) return null;
      if (slot && deps.now() - slot.at < retryMs) return null;
      read(key, routeId, model);
      const now = slots.get(key);
      return now && 'value' in now ? now.value : null;
    },
    async settled() {
      await Promise.all([...slots.values()].flatMap((s) => ('reading' in s ? [s.reading] : [])));
    },
  };
}
