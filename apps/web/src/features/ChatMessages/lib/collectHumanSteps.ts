import type { SplitHumanStepView } from '@agentdeck/contracts/split-tickets';
import type { SplitPlanView } from '@agentdeck/contracts/chat-handoff';
import { splitHumanStepKey } from '@agentdeck/contracts/split-tickets';

/** Шаг человеку в хабе: сам шаг и группы, которые о нём просят. */
export interface HubHumanStep extends SplitHumanStepView {
  key: string;
  groups: string[];
}

/**
 * Шаги человеку всех групп одним списком (находка 112): две группы, которым
 * нужна одна и та же зависимость MR, просят о ней одинаково — в списке она одна.
 */
export function collectHumanSteps(groups: SplitPlanView['groups']): HubHumanStep[] {
  const byKey = new Map<string, HubHumanStep>();
  for (const group of groups) {
    for (const step of group.humanSteps ?? []) {
      const key = splitHumanStepKey(step);
      const known = byKey.get(key);
      if (known) {
        if (!known.groups.includes(group.title)) known.groups.push(group.title);
        continue;
      }
      byKey.set(key, { ...step, key, groups: [group.title] });
    }
  }
  return [...byKey.values()];
}
