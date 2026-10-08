import type { Platform } from '@agentdeck/contracts';
import { sideOff } from './sideOff';
import { rulesAppliesOf } from './rulesAppliesOf';

/**
 * Замки взаимного исключения набора инструментов контура и прослойки — по
 * ДЕЙСТВУЮЩЕМУ набору, как судит сервер (`brokenExclusion` →
 * `effectivePlatformRules`): при «Только наши» набор контура в прогон не идёт,
 * и прослойку он не запирает. Записанный набор запирал её зря, а выходом было
 * удалить список, который выбор обещает сохранить (ревью 28.09 F-82).
 *
 * Каждая сторона запирает ТОЛЬКО добавление своей: уже записанный набор
 * правится и убирается и при включённой прослойке (ревью Т7).
 */
export function toolExclusionLocks(platform: Platform): {
  toolsLocked: boolean;
  shimLocked: boolean;
} {
  const contourOn = !sideOff(rulesAppliesOf(platform)).contour;
  const written = (platform.rules?.platform?.platformTools ?? []).length > 0;
  return {
    toolsLocked: platform.toolShim && contourOn && !written,
    shimLocked: !platform.toolShim && contourOn && written,
  };
}
