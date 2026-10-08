import type { PlatformRunPlan } from '@agentdeck/contracts';
import type { PlatformRefusalParams } from './index.types';
import { refusalParams } from './refusalParams';

/**
 * Подпись «прогон уйдёт мимо контура» — «по возможности» без шлюза или ключа.
 *
 * Решение по контуру №4: режим остаётся, только пока каждый такой уход назван в
 * шапке прямо. Без этой строки чат выглядел бы идущим через контур, а данные
 * молча уезжали бы в облако вендора — ровно то, от чего контур защищает. Причины
 * и советы — те же слова, что у отказа: чинится одно и то же.
 */
export function platformBypassCaption(
  plan: PlatformRunPlan | undefined,
): { key: 'chat.platformBypassed'; params: PlatformRefusalParams } | undefined {
  if (!plan?.bypassed) return undefined;
  return { key: 'chat.platformBypassed', params: refusalParams(plan) };
}
