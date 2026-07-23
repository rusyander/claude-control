import type { EntityRef, Group, GroupMember } from '@claude-control/contracts';

/**
 * Обход графа групп: вложенная группа может входить участником в другую, поэтому
 * состав группы — это дерево, а не плоский список. Здесь оно разворачивается в
 * набор сущностей-листьев и проверяется на циклы.
 *
 * Обход всегда конечен: одна и та же группа не разворачивается повторно на
 * текущей ветке (защита от циклов A→B→A), а глубина ограничена сверху — даже на
 * повреждённых данных функция вернётся, а не уйдёт в бесконечную рекурсию.
 */

/** Предел вложенности групп — страховка обхода поверх защиты от циклов. */
export const MAX_GROUP_DEPTH = 32;

/**
 * Плоский список сущностей-листьев группы: рекурсивно разворачивает вложенные
 * группы, отбрасывает самих участников-группы и дедуплицирует. Именно по этому
 * списку идёт включение/выключение и простановка отметок «погашено группой» —
 * по всей ветке, а не только по прямым участникам.
 */
export function collectLeafMembers(groups: Group[], root: GroupMember[]): EntityRef[] {
  const byId = new Map(groups.map((group) => [group.id, group]));
  const leaves: EntityRef[] = [];
  const seen = new Set<string>();
  const path = new Set<string>();

  const walk = (members: GroupMember[], depth: number): void => {
    if (depth > MAX_GROUP_DEPTH) return;

    for (const member of members) {
      if (member.kind === 'group') {
        // Уже на текущей ветке — это цикл, глубже не идём.
        if (path.has(member.id)) continue;
        const sub = byId.get(member.id);
        if (!sub) continue;
        path.add(member.id);
        walk(sub.members, depth + 1);
        path.delete(member.id);
        continue;
      }

      const key = `${member.kind} ${member.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      leaves.push({ kind: member.kind, id: member.id });
    }
  };

  walk(root, 0);
  return leaves;
}

/**
 * Создаст ли группа цикл, если её прямой состав станет `members`. Цикл — это
 * путь по вложенным группам, возвращающийся к самой группе (в том числе прямая
 * ссылка на себя). Стартуем от нового состава и идём по вложенным группам через
 * их текущий состав; если добрались до `groupId` — цикл.
 */
export function wouldCreateCycle(
  groups: Group[],
  groupId: string,
  members: GroupMember[],
): boolean {
  const byId = new Map(groups.map((group) => [group.id, group]));
  const seen = new Set<string>();

  const reaches = (id: string): boolean => {
    if (id === groupId) return true;
    if (seen.has(id)) return false;
    seen.add(id);
    const group = byId.get(id);
    if (!group) return false;
    return group.members.some((member) => member.kind === 'group' && reaches(member.id));
  };

  return members.some((member) => member.kind === 'group' && reaches(member.id));
}
