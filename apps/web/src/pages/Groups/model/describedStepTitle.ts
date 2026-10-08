import type { GroupMembersView } from '@agentdeck/contracts';
import type { SkillStepTitle } from './tile.types';
import { pickLang } from '@features/GroupPath';

/**
 * Название шага скилла из описаний состава: описан — на языке интерфейса; ещё
 * описывается — в неанглийском интерфейсе пропуск (английский заголовок в
 * русской карточке и был жалобой); описать не вышло — оригинал.
 */
export function describedStepTitle(
  view: GroupMembersView | undefined,
  language: string,
): SkillStepTitle {
  return (entry) => {
    const described = view?.steps.find(
      (item) => item.skillId === entry.skillId && item.index === entry.index,
    );
    if (described) return pickLang(described.title, language) || entry.title;
    if (language.startsWith('en')) return entry.title;
    // Состав ещё не пришёл или шаги скилла в очереди — ждём слов, а не показываем английский.
    if (!view || (view.pending ?? []).includes(`step:${entry.skillId}`)) return undefined;
    return entry.title;
  };
}
