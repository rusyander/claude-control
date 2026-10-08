import type { GroupListItem } from '@entities/Group';
import { projectPathOf } from './projectPathOf';

/**
 * «Найдено в»: у проектной группы — её проект, у глобальной копии — проект
 * оригинала. У группы, собранной руками в панели, места находки нет.
 */
export function foundInOf(group: GroupListItem): string | undefined {
  const own = projectPathOf(group);
  if (own) return own;
  const origin = group.origin?.scope;
  return origin && origin.kind === 'project' ? origin.path : undefined;
}
