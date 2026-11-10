import type { BrowserDriverOptions, SessionMaskBook, WalkPort } from './browser.types.ts';
import { createBrowserDriver } from './driver.ts';
import { createStandOrigins } from './stand-origins.ts';
import { createStandSecrets } from './stand-secrets.ts';

/**
 * Порт прохода по стенду (этап 12, R1/R2): браузер ядра, доступы стенда и маска сессии одним
 * объектом. Собирает загрузка ядра; браузер не стартует, пока модель не открыла страницу.
 */

export type * from './browser.types.ts';
export { createBrowserDriver } from './driver.ts';
export { createStandSecrets, readStandEnvironments } from './stand-secrets.ts';
export { createStandOrigins, isLoopbackHost, ORIGIN_NOT_ALLOWED } from './stand-origins.ts';
export { installCommandFor } from './no-browser.ts';

export interface WalkPortDeps {
  /** Папка данных панели (хранилище ключей); нет — доступы стенда `secret-unwired`. */
  panelAppData: string | null | undefined;
  /** Книга маски сессии: значение подставленного секрета прячется всюду, куда его эхо дойдёт. */
  keys: SessionMaskBook;
  /** Значения, уже известные маске сессии (`bootEconomy().known`). */
  known(taskId: string, sessionId: string): readonly string[];
  driver?: BrowserDriverOptions;
}

export function createWalkPort(deps: WalkPortDeps): WalkPort {
  const driver = createBrowserDriver(deps.driver);
  return {
    driver,
    secrets: createStandSecrets(deps.panelAppData),
    stands: createStandOrigins(),
    mask: deps.keys,
    known: deps.known,
    close: () => driver.close(),
  };
}
