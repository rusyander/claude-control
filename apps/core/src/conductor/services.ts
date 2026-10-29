/**
 * Сервисы задачи в дирижёре (04:75-77, 04:124-127; P40, P58, P90) — фасад над `services/`:
 * запуск по требованию проверки (`ensure.ts`), снятие с чтением назад и команда
 * `release-resource` (`release.ts`), сверка контейнеров и дорога движка (`readers.ts`), стенд
 * (`stand.ts`), записи ресурсов (`refs.ts`).
 */
export { createEnsureServices, type ServicesDeps } from './services/ensure.ts';
export {
  releaseByKind,
  releaseResource,
  releaseRow,
  releaseServices,
  type ReleaseDeps,
  type ReleaseOutcome,
} from './services/release.ts';
export {
  containerActionReaders,
  containerRemoveReader,
  containerStartReader,
  engineRoadProbe,
} from './services/readers.ts';
export { attachStand } from './services/stand.ts';
export type {
  CacheVolumeRef,
  ContainerHint,
  ServiceContainerRef,
  StandRef,
} from './services/refs.ts';
