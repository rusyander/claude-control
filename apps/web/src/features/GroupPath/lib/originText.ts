import type { Translate } from '../ui/StepDetailModal/StepDetailModal.types';
import type { StepSource } from '../model/stepSource.types';

export function originText(t: Translate, source: StepSource): string {
  const params = {
    id: source.id ?? '',
    project: source.project ?? '',
    plugin: source.plugin ?? '',
  };
  const own = t(`groupPath.detail.origin.${source.kind}`, params);
  // Шаг, превращённый в скилл: сперва — что с ним сделали, затем — где скилл лежит.
  return source.resourceType === 'skill'
    ? `${t('groupPath.detail.promotedSkill', params)} ${own}`
    : own;
}
