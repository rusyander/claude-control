import { readCoreConfig } from '../platform/core-config/read.ts';
import type { CoreHomeLayout } from '../platform/core-home.ts';

/**
 * Явный путь CLI переходника из раздела `cliPaths` настройки ядра (этап 9, F9). Читается на
 * каждом обращении — правка через `/v1/config` действует со следующей сессии и следующей
 * предпроверки, без перезапуска ядра. Настройка не прочлась или пути нет — `undefined`: решает
 * поиск по PATH, как до раздела.
 */
export function cliPathOf(
  layout: Pick<CoreHomeLayout, 'config'>,
): (adapterId: string) => string | undefined {
  return (adapterId) => {
    const read = readCoreConfig(layout);
    return 'value' in read ? read.value.doc.cliPaths?.[adapterId] : undefined;
  };
}
