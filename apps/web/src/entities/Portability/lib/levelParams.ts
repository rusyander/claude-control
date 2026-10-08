import type { PortabilityLevel } from '../api/PortabilityApi.types';

/** Уровень в параметрах запроса. Пустой проект не отправляется вовсе. */
export function levelParams(level: PortabilityLevel): Record<string, string> {
  return { scope: level.scope, ...(level.project ? { project: level.project } : {}) };
}
