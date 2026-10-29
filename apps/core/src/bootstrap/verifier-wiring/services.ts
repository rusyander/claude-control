import type { ServiceRecipe } from '@agentdeck/contracts/core/records';
import {
  containerActionReaders,
  createEnsureServices,
  engineRoadProbe,
  releaseResource,
  releaseServices,
  type ServicesDeps,
} from '../../conductor/services.ts';
import type { TaskRegistry } from '../../conductor/tasks.ts';
import { runContract } from '../../verifier/classes/contract.ts';
import { runMigrations } from '../../verifier/classes/migration.ts';
import { createStandRegistry, type StandRegistry } from '../../verifier/stand/index.ts';

/**
 * Зона F (сервисы в контейнерах, стенд, классы миграций и контрактов). Задача берётся из
 * реестра живых задач; рецепты сервисов знает профиль, закреплённый за задачей, — их передаёт
 * вызывающий (очередь проверок), здесь их не угадать. Вставки в чужие зоны: читатели
 * `container-start`/`container-remove` — в `action-readers.ts`, проба движка — в
 * `preflight(..., extra)` под ключом `container-engine`, `releaseServices` — на конец задачи,
 * `stands.standEpoch` — вход зоны C. Защищённые корни (P04) — у дороги сессии одной
 * (`protected-step.ts`), второй дороги к ним здесь нет (ревью A2r2-F03).
 */
export interface ServicesWiring {
  ensureServices(
    recipes: (taskId: string) => Promise<readonly ServiceRecipe[]> | readonly ServiceRecipe[],
    options?: Omit<ServicesDeps, 'task' | 'recipes'>,
  ): ReturnType<typeof createEnsureServices>;
  stands: StandRegistry;
  releaseResource: typeof releaseResource;
  releaseServices: typeof releaseServices;
  containerActionReaders: typeof containerActionReaders;
  engineRoadProbe: typeof engineRoadProbe;
  runMigrations: typeof runMigrations;
  runContract: typeof runContract;
}

export function servicesWiring(deps?: { registry: TaskRegistry }): ServicesWiring {
  return {
    ensureServices: (recipes, options = {}) =>
      createEnsureServices({
        ...options,
        task: (taskId) => deps?.registry.live(taskId),
        recipes,
      }),
    stands: createStandRegistry(),
    releaseResource,
    releaseServices,
    containerActionReaders,
    engineRoadProbe,
    runMigrations,
    runContract,
  };
}
