import type { PathEntry } from '@agentdeck/contracts';
import type { PathSlot } from './pathEdit.types';
import { anchorAfter } from './anchorAfter';

export function isInSkillBlock(entry: PathEntry | undefined): boolean {
  return entry?.kind === 'skill-step' || (entry?.kind === 'custom' && Boolean(entry.step.within));
}

/**
 * Место шага, вставленного между строкой `index` и следующей. Рядом с шагами
 * скилла шаг встаёт ВНУТРЬ его порядка (`within`): иначе сервер унёс бы его
 * ниже всего блока скиллов, и «+» между шагами 4 и 5 соврал бы. После
 * последнего шага блока — обычный шаг стадии: он идёт отдельным ходом.
 */
export function slotAfter(entries: PathEntry[], index: number): PathSlot {
  const entry = entries[index];
  const next = entries[index + 1];
  if (entry?.kind === 'custom' && entry.step.within) {
    return { anchor: entry.step.anchor, within: entry.step.within };
  }
  if (entry?.kind === 'skill-step' && isInSkillBlock(next)) {
    return {
      anchor: 'work',
      within: { skillId: entry.skillId, index: entry.index, after: entry.title },
    };
  }
  if (entry?.kind === 'builtin' && isInSkillBlock(next)) {
    if (next?.kind === 'custom' && next.step.within) {
      return { anchor: next.step.anchor, within: next.step.within };
    }
    if (next?.kind === 'skill-step') {
      return { anchor: 'work', within: { skillId: next.skillId, index: -1, after: '' } };
    }
  }
  return { anchor: anchorAfter(entries, index) };
}
