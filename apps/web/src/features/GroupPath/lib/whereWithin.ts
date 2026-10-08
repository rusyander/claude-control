import { useTranslation } from 'react-i18next';

export type Translate = ReturnType<typeof useTranslation>['t'];

export function whereWithin(t: Translate, within: { skillId: string; after: string }): string {
  return within.after
    ? t('groupPath.composer.whereWithin', { id: within.skillId, step: within.after })
    : t('groupPath.composer.whereWithinFirst', { id: within.skillId });
}
