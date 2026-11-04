import { fileURLToPath } from 'node:url';

/**
 * Корень репозитория панели — от этого файла (`apps/server/src/lib/app-root/`), а не от cwd:
 * сервер запускают и из корня, и из `apps/server`, а путь к своим файлам должен быть один.
 */
export function appRootDir(): string {
  return fileURLToPath(new URL('../../../../../', import.meta.url));
}
