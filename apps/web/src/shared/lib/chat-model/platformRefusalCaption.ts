import type { PlatformRunPlan } from '@agentdeck/contracts';
import type { PlatformRefusalParams } from './index.types';
import { refusalParams } from './refusalParams';

/**
 * Подпись «прогон будет отклонён» — обязательный контур без шлюза или ключа.
 * Сервер отказывает при отправке; без этой строки человек узнал бы об отказе
 * только по ошибке в ленте, а раньше — не узнал бы вовсе: прогон молча уходил
 * в облако вендора (живое подключение 14.09.2026).
 */
export function platformRefusalCaption(
  plan: PlatformRunPlan | undefined,
): { key: 'chat.platformRefused'; params: PlatformRefusalParams } | undefined {
  if (!plan?.refused) return undefined;
  return { key: 'chat.platformRefused', params: refusalParams(plan) };
}
