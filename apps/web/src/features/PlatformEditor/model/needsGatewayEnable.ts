import type { PlatformGatewaySettings } from '@agentdeck/contracts';

/**
 * Включать ли шлюз перед подъёмом. Уже включённый не трогаем: лишняя запись
 * настроек — лишний перезапуск слушателя, а его сейчас слушают живые CLI.
 */
export function needsGatewayEnable(settings: PlatformGatewaySettings | undefined): boolean {
  return Boolean(settings && !settings.enabled);
}
