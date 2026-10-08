import type { PlatformApplyTarget } from '@agentdeck/contracts';
import { PLATFORM_ASSISTANT_TARGET } from '@agentdeck/contracts';

/** Файловые цели (не ассистент), в которые контур уже записан. */
export function appliedFileTargets(targets: readonly PlatformApplyTarget[]): Set<string> {
  return new Set(
    targets
      .filter((target) => target.targetId !== PLATFORM_ASSISTANT_TARGET && target.applied)
      .map((target) => target.targetId),
  );
}
