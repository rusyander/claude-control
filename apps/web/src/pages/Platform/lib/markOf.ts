import type { PlatformApplyTarget, PlatformToolRoute, CompromiseId } from '@agentdeck/contracts';
import { PLATFORM_ASSISTANT_TARGET } from '@agentdeck/contracts';
import { toolRouteMark } from '@entities/Platform';

/**
 * Подпись стоит вплотную к тому, что объясняет: у прочерка — про отсутствие
 * настройки адреса, у CLI на контуре — про то, чем дойдут его инструменты. У
 * ассистента панели подписи нет: у него работает всё.
 */
export function markOf(target: PlatformApplyTarget, route: PlatformToolRoute): CompromiseId | null {
  if (!target.supported) return 'cli-no-endpoint';
  if (target.targetId === PLATFORM_ASSISTANT_TARGET) return null;
  return toolRouteMark(route);
}
