import type { PlatformApplyTarget, PlatformToolRoute } from '@agentdeck/contracts';
import { PLATFORM_ASSISTANT_TARGET } from '@agentdeck/contracts';

export function stateWord(
  target: PlatformApplyTarget,
  route: PlatformToolRoute,
  t: (key: string) => string,
): string {
  if (!target.supported) return t(`platform.targetReason.${target.reason ?? 'no_env_section'}`);
  if (!target.applied) return t('platform.targetNotApplied');
  if (target.targetId === PLATFORM_ASSISTANT_TARGET) return t('platform.targetApplied');
  return t(`platform.targetAppliedTools.${route}`);
}
