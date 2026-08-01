import type { SettingsSource } from '@claude-control/contracts';
import type { ServerContext } from '../../context.ts';
import { isLocalId } from '../../lib/settings-source.ts';

/**
 * Пути активного каталога конфигурации. Берутся на каждом обращении, а не один
 * раз при регистрации маршрутов: каталог меняется на лету (`ctx.relocate`).
 */
export type ClaudePaths = ServerContext['location']['paths'];

/**
 * В какой файл писать запись с этим идентификатором.
 *
 * Правка локальной записи возвращается в `settings.local.json`, а не
 * переезжает в общий конфиг: личная настройка иначе стала бы общей. Префикс
 * `local:` живёт только в панели — файлу он неизвестен, поэтому снимается.
 */
export const targetOf = (
  ctx: ServerContext,
  id: string,
): { path: string; source: SettingsSource } =>
  isLocalId(id)
    ? { path: ctx.location.paths.settingsLocal, source: 'settings-local' }
    : { path: ctx.location.paths.settings, source: 'settings' };
