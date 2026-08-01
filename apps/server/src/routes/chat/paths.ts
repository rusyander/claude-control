import { join, isAbsolute } from 'node:path';
import { statSync } from 'node:fs';
import type { ServerContext } from '../../context.ts';

/**
 * Папка разговоров Claude Code. Считается на каждом обращении, а не один раз
 * при регистрации маршрутов: каталог конфигурации меняется на лету
 * (`ctx.relocate` из настроек), и запомненный путь оставлял бы чат читать
 * ПРЕЖНИЙ каталог до перезапуска сервера — с пустым списком и без объяснений.
 */
export const projectsDir = (ctx: ServerContext): string =>
  join(ctx.location.paths.root, 'projects');

/**
 * Каталог, в котором можно начать новый разговор проекта. Путь приходит от
 * клиента (пользователь выбрал проект из списка), поэтому подтверждаем, что
 * это существующий каталог: иначе Claude запустится не пойми где. Отсутствие
 * каталога не ошибка запроса — просто не переопределяем рабочую папку.
 */
export const validTargetCwd = (path: string | undefined): string | undefined => {
  if (!path || !isAbsolute(path)) return undefined;
  try {
    return statSync(path).isDirectory() ? path : undefined;
  } catch {
    return undefined;
  }
};
