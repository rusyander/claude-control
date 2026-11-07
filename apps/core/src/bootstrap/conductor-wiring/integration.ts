import { integrationHooks as gateHooks } from '../../conductor/gates/integration-hooks.ts';
import type { ConductorHooks } from '../../conductor/run/run.types.ts';
import { copyWiring } from '../copy-wiring.ts';
import type { ConductorWiringDeps } from './conductor-wiring.types.ts';

/**
 * Ворота интеграции в сборе (этап 11, W3-18b): шаг `integration-gate` единицы интеграции без
 * копии сливает головы единиц заново (та же копия, что у зоны F) — конфликт снят, копия легла,
 * ворота зелёные; нет — шаг красный с файлами и парой веток, единицы не публикуются.
 */
export function integrationHooks(deps: ConductorWiringDeps): ConductorHooks {
  const copy = copyWiring({
    registry: deps.registry,
    layout: deps.layout,
    profileOf: deps.verifier.profile.profileOf,
  });
  return gateHooks({
    live: (taskId) => deps.registry.live(taskId),
    prepare: (taskId, unitId) => copy.prepare(taskId, unitId),
  });
}
