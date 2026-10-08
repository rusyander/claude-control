import type { PlatformToolRoute } from '@agentdeck/contracts';

/**
 * Показывать ли решённый факт «инструменты объявляются текстом». Он про тип,
 * который `tools` полем не принимает, и у раздела, где все контуры получают
 * инструменты полем, это утверждение ложно (аудит DRV-13). Без контуров факт
 * остаётся: он объясняет, чем раздел обычно платит, до первого подключения.
 */
export function showsToolsFact(routes: readonly PlatformToolRoute[]): boolean {
  return routes.length === 0 || routes.some((route) => route !== 'native');
}
