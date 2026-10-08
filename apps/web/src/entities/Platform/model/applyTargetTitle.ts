import type { PlatformApplyTarget } from '@agentdeck/contracts';
import { PLATFORM_ASSISTANT_TARGET } from '@agentdeck/contracts';

/**
 * Подпись цели. Имя ассистента сервер пишет по-русски, а CLI зовутся своими
 * торговыми именами — поэтому переводится только ассистент, остальное как есть.
 */
export function applyTargetTitle(
  target: Pick<PlatformApplyTarget, 'targetId' | 'title'>,
  t: (key: string) => string,
): string {
  return target.targetId === PLATFORM_ASSISTANT_TARGET
    ? t('platform.consumer.assistant')
    : target.title;
}
