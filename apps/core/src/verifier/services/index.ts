/** Сервисы проверок (04:124-127): рецепт → контейнер задачи → адрес для копии. */
export { containerEnv, endpointOf, mainPort, publishPorts, readinessArgv } from './recipe.ts';
export { SERVICE_LABEL, serviceLabels, startService, stopService } from './start.ts';
export type {
  EnsureServices,
  ServiceIo,
  ServiceStartOptions,
  StartedService,
} from './services.types.ts';
