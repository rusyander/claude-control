import type { UnknownAction } from '@agentdeck/contracts/core/facts';
import type { RouteFactDecl, RouteFactName } from '@agentdeck/contracts/core/routes';
import { READ_CLASSES } from '../lib/facts/read-classes.ts';

/**
 * Объявление фактов маршрута (01 §Facts, P111): каждый факт — класс чтения `route.<факт>` и
 * действие на `unknown`. По умолчанию действие класса; маршрут переопределяет своё (вход CLI:
 * доступность `unknown` → запуск, отказ читается в потоке — 11 R:PR-03).
 */

const FACT_NAMES: readonly RouteFactName[] = [
  'availability',
  'models',
  'limit',
  'price',
  'credential',
  'context',
];

export function routeFactDecls(
  overrides: Partial<Record<RouteFactName, UnknownAction>> = {},
): RouteFactDecl[] {
  return FACT_NAMES.map((fact) => {
    const readClass = `route.${fact}` as const;
    return { fact, readClass, onUnknown: overrides[fact] ?? READ_CLASSES[readClass].onUnknown };
  });
}
