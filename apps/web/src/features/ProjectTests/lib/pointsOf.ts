import type { ProjectTestCase } from '@agentdeck/contracts';
import { combineParams } from '@agentdeck/contracts/test-format';

/** Во сколько проходов разворачивается кейс: полный перебор его параметров. */
export function pointsOf(item: ProjectTestCase): number {
  const combos = combineParams(item.parameters ?? []);
  return combos.length > 0 ? combos.length : 1;
}
