import type { TmsSettings } from '@agentdeck/contracts';
import { IntegrationError } from '../errors.ts';
import { zephyrClient } from './zephyr.ts';
import { xrayClient } from './xray.ts';
import { testitClient } from './testit.ts';
import type { TmsClient } from './types.ts';

export type { TmsCase, TmsClient, TmsRunPush } from './types.ts';
export { externalKeys, keyFromTags, keyLookup, sourceTag } from './types.ts';

/**
 * Выбор системы тест-менеджмента по настройке.
 *
 * Честное «не подключено» отдаётся ЗДЕСЬ и одинаково для обеих: карточка на
 * странице может быть заполнена наполовину (вид выбран, токена нет), и разница
 * между «выключено» и «сломалось» должна быть видна человеку сразу — иначе он
 * пойдёт чинить сеть вместо того, чтобы вписать ключ.
 */
export function tmsClient(settings: TmsSettings, token: string | undefined): TmsClient {
  if (!settings.enabled || !token) {
    throw new IntegrationError(
      'integration_not_found',
      'Тест-менеджмент не подключён: включите его и сохраните токен в настройках панели.',
    );
  }
  if (settings.kind === 'zephyr') return zephyrClient(token, settings.projectKey);
  if (settings.kind === 'xray') return xrayClient(token, settings.projectKey);
  // Адрес читает только Test IT: у двух облачных он общий на всех и в настройке
  // не спрашивается вовсе.
  if (settings.kind === 'testit') {
    return testitClient(token, settings.projectKey, settings.baseUrl);
  }
  throw new IntegrationError(
    'integration_not_found',
    'Тест-менеджмент не подключён: не выбрана система (Zephyr Scale, Xray или Test IT).',
  );
}
