/**
 * Движок контейнеров (04:121-127, 09:30, P58) — фасад над `container-engine/`: проба движка
 * (`probe.ts`) и действия над ним (`ops.ts`). Все различия Docker / Podman / Colima / OrbStack и
 * сокетов ОС живут здесь (P51); выше — только `EngineInfo` и исходы.
 */
export {
  engineFact,
  engineHandle,
  engineKind,
  handleOf,
  knownSockets,
} from './container-engine/probe.ts';
export {
  CACHE_LABEL,
  EPHEMERAL_LABEL,
  containerLabels,
  containerPresent,
  ensureCacheVolume,
  execIn,
  listByLabels,
  publishedPorts,
  removeCacheVolume,
  removeEphemeral,
  removePod,
  removeSessionContainer,
  runContainer,
  runEngine,
} from './container-engine/ops.ts';
export type {
  ContainerRow,
  ContainerSpec,
  EngineHandle,
  EngineProbeOptions,
  EngineRelease,
  EngineRun,
} from './container-engine.types.ts';
