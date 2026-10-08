import type { PathEntry, PathAnchor } from '@agentdeck/contracts';
import { isScenarioPath } from './isScenarioPath';
import { SCENARIO_ANCHOR } from './pathEdit.constants';
import { PATH_ANCHORS } from '@agentdeck/contracts';

/**
 * К какой стадии относится вставка после строки `index`: ближайшая стадия
 * выше по списку (или стадия ближайшего своего шага). Шаги скилла стадии не
 * задают — это показ, их пропускаем. Выше ничего нет — первая стадия.
 *
 * У сценария ряд один (F-126): вставка наверх под первую стадию давала ему
 * вторую, и позиция «встать N-м», посчитанная по ряду `work`, промахивалась.
 */
export function anchorAfter(entries: PathEntry[], index: number): PathAnchor {
  if (isScenarioPath(entries)) return SCENARIO_ANCHOR;
  for (let position = Math.min(index, entries.length - 1); position >= 0; position -= 1) {
    const entry = entries[position];
    if (entry?.kind === 'builtin') return entry.stage;
    if (entry?.kind === 'custom') return entry.step.anchor;
  }
  return PATH_ANCHORS[0] ?? 'triage';
}
