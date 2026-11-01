import type { ConductorHooks } from '../../conductor/run/run.types.ts';
import {
  createPublishWiring,
  type PublishWiring,
  type PublishWiringOptions,
} from '../publish-wiring/index.ts';
import type { ConductorWiringDeps } from './conductor-wiring.types.ts';

/**
 * Зона P этапа 6 — публикатор: композиция коммитов под состав финальной проверки, затем шаг
 * публикации — готовность, синхронизация с базой, пуш и MR через outbox, чтение нитей один раз.
 * Сама проводка — `bootstrap/publish-wiring`; здесь только подключение к дирижёру.
 *
 * Одна проводка на одни `deps` (`publishWiringFor`): крючки и порт команд (`publish-now` двигает
 * ту же очередь, которой ждут попытки) — общий объект, как `splitEnvFor` у зоны D.
 */
const wirings = new WeakMap<ConductorWiringDeps, PublishWiring>();

export function publishWiringFor(
  deps: ConductorWiringDeps,
  options: PublishWiringOptions = {},
): PublishWiring {
  const known = wirings.get(deps);
  if (known) return known;
  const made = createPublishWiring(
    {
      registry: deps.registry,
      coreHome: deps.layout.root,
      scenariosDir: deps.layout.scenarios,
      note: deps.note,
    },
    options,
  );
  wirings.set(deps, made);
  return made;
}

export function publishHooks(deps: ConductorWiringDeps): ConductorHooks {
  return publishWiringFor(deps).hooks;
}
