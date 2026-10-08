import type { PlatformApplyTarget } from '@agentdeck/contracts';
import { PLATFORM_ASSISTANT_TARGET } from '@agentdeck/contracts';

/**
 * Порядок целей в списке «Применён к»: ассистент панели, поддержанные CLI,
 * прочерки. Сортировка устойчивая — внутри группы порядок реестра провайдеров
 * сохраняется, иначе список перетасовывался бы от ответа к ответу.
 */
export function sortApplyTargets(targets: PlatformApplyTarget[]): PlatformApplyTarget[] {
  const rank = (target: PlatformApplyTarget): number => {
    if (target.targetId === PLATFORM_ASSISTANT_TARGET) return 0;
    return target.supported ? 1 : 2;
  };
  return [...targets].sort((left, right) => rank(left) - rank(right));
}
