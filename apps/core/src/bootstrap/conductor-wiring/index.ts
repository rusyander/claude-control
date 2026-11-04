import type { ConductorHandle, ConductorWiringDeps, ZoneHooks } from './conductor-wiring.types.ts';
import { guardHooks } from './guard.ts';
import { humanHooks } from './human.ts';
import { publishHooks, publishWiringFor } from './publish.ts';
import { loopHooks } from './loop.ts';
import { observerHooks } from './observer.ts';
import { startLoops, type Loops } from './loops.ts';
import { requirementsHooks } from './requirements.ts';
import { reviewLinkHooks, reviewLinkWiringFor } from './review-link.ts';
import { scenarioHooks, type ScenarioWiringDeps } from './scenario.ts';
import { processPin } from './session-start.ts';
import { splitEnvFor, splitHooks } from './split.ts';
import { userLayerHooks } from './user-layer.ts';
import { wiringHooks } from './wiring.ts';

/**
 * Дирижёр этапа 4 в сборе: по файлу на зону, `boot.ts` запускает его один раз. Порядок крючков
 * постоянный и здесь: копия (F) раньше карты владения (D) на старте единицы, бриф и уровень (A)
 * раньше требований (C) и вопросов (E) перед шагом, слой пользователя (этап 7) после вопросов —
 * его отказ хука останавливает шаг раньше стража и публикатора, страж публикации (этап 6) раньше публикатора —
 * чужая публикация останавливает шаг до того, как ядро опубликует своё, цикл (B) последним — он
 * решает по фактам остальных. Исполнитель (`loops.ts`) зовёт их у каждой запущенной задачи ядра.
 */
export const ZONE_ORDER: readonly ZoneHooks[] = [
  wiringHooks,
  scenarioHooks,
  splitHooks,
  requirementsHooks,
  humanHooks,
  userLayerHooks,
  observerHooks,
  guardHooks,
  // Ревью по ссылке (этап 10, F8) — раньше публикатора: итог в MR и «не пушить» решаются здесь.
  reviewLinkHooks,
  publishHooks,
  loopHooks,
];

/**
 * Опись слоя человека для шагов-навыков брифа (06:121): переходник шага по суду `tier`, копия
 * единицы, пин исполнителя. Слой репозитория не берётся — доверие копии решает дорога на запуске,
 * до него бриф называет только навыки самого человека. Нет переходника, описи или копии — `null`.
 */
export function stepInventory(deps: ConductorWiringDeps): ScenarioWiringDeps['userLayerInventory'] {
  const pin = (deps.loop ? deps.loop.pin : undefined) ?? (() => processPin());
  return (s) => {
    const tier = s.routing?.tier;
    const adapter = tier?.ok ? deps.adapters?.get(tier.adapter) : undefined;
    if (!adapter?.inventory || !s.copyDir) return null;
    return adapter.inventory(pin(), s.copyDir, false);
  };
}

export function startConductor(deps: ConductorWiringDeps): ConductorHandle {
  const zoneDeps: ScenarioWiringDeps = { userLayerInventory: stepInventory(deps), ...deps };
  // Опись слоя нужна только сценарию; остальные зоны получают сами `deps`: их проводки
  // (`publishWiringFor`, `splitEnvFor`, `reviewLinkWiringFor`) — одна на объект `deps`, и ручка
  // ниже обязана держать ту же, что крючки (иначе `publish-now` двигал бы чужую очередь).
  const hooks = ZONE_ORDER.map((zone) => (zone === scenarioHooks ? zone(zoneDeps) : zone(deps)));
  deps.note('conductor.started', { zones: hooks.length });
  let loops: Loops | null = null;
  return {
    hooks,
    // Та же среда, что у `splitHooks(deps)` выше: `splitEnvFor` одна на одни `deps`.
    split: splitEnvFor(deps),
    // Та же проводка, что у `publishHooks(deps)`: `publish-now` двигает очередь, которой ждут попытки.
    publisher: publishWiringFor(deps).commands,
    // Та же проводка, что у `reviewLinkHooks(deps)`: ручка открывает задачу, крючки её ведут.
    reviewLink: reviewLinkWiringFor(deps),
    start() {
      if (loops || deps.loop === false || !deps.adapters) return;
      loops = startLoops({
        registry: deps.registry,
        road: deps.road,
        adapters: deps.adapters,
        scenariosDir: deps.layout.scenarios,
        hooks,
        note: deps.note,
        options: deps.loop ?? {},
        ...(deps.economy ? { economy: deps.economy } : {}),
        ...(deps.measureBase ? { measureBase: deps.measureBase } : {}),
        ...(deps.taskEnv ? { taskEnv: deps.taskEnv } : {}),
      });
    },
    running: () => loops?.running() ?? [],
    async stop() {
      // Исполнители — `keep`: сессии переживают остановку ядра, следующее их прикрепит (P89).
      await loops?.stop();
      deps.note('conductor.stopped', {});
    },
  };
}

export type {
  ConductorHandle,
  ConductorWiringDeps,
  LoopOptions,
  ZoneHooks,
} from './conductor-wiring.types.ts';
