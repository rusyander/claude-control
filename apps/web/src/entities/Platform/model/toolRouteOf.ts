import type { PlatformToolRoute, Platform } from '@agentdeck/contracts';

/**
 * Маршрут инструментов из ответа сервера. Сервер старее фронта поля не
 * присылает — тогда прежний смысл тумблера: прослойка включена или инструментов
 * нет вовсе.
 */
export function toolRouteOf(source: {
  toolRoute?: PlatformToolRoute;
  platform?: Pick<Platform, 'toolShim'>;
}): PlatformToolRoute {
  return source.toolRoute ?? (source.platform?.toolShim ? 'shim' : 'none');
}
