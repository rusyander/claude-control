import type { Translate } from '../ui/StepDetailModal/StepDetailModal.types';
import type { PathRow } from '../model/pathRows.types';
import { PATH_ANCHORS } from '@agentdeck/contracts';

export function whereText(t: Translate, row: PathRow): string {
  if (row.kind === 'skill') return t('groupPath.detail.whereWhole');
  const { entry } = row;
  if (entry.kind === 'builtin') {
    return t('groupPath.detail.whereBuiltin', {
      number: PATH_ANCHORS.indexOf(entry.stage) + 1,
      total: PATH_ANCHORS.length,
    });
  }
  if (entry.kind === 'skill-step') {
    return t('groupPath.detail.whereSkill', { number: entry.index + 1, id: entry.skillId });
  }
  const { within } = entry.step;
  if (within) {
    return within.after
      ? t('groupPath.detail.whereWithin', { id: within.skillId, step: within.after })
      : t('groupPath.detail.whereWithinFirst', { id: within.skillId });
  }
  return t('groupPath.detail.whereAfter', { stage: t(`groupPath.stage.${entry.step.anchor}`) });
}
