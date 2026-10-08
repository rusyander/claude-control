import type { PathStep } from '@agentdeck/contracts';
import { placed } from './placed';

/** Заменить шаг с тем же id (правка текста) — место и стадия остаются. */
export function replaceStep(steps: PathStep[], step: PathStep): PathStep[] {
  return steps.map((item) =>
    item.id === step.id
      ? placed(step, { anchor: item.anchor, ...(item.within ? { within: item.within } : {}) })
      : item,
  );
}
