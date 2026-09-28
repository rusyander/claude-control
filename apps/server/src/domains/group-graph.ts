import type { EntityRef, Group, GroupMember } from '@agentdeck/contracts';
import { inClaudeGlobals, type GroupScope } from '@agentdeck/contracts/group-sources';

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
export function collectLeafMembers(
  groups: Group[],
  root: GroupMember[],
  rootScope?: GroupScope,
): EntityRef[] {
  // Только общие группы: обход в проектные не спускается, а проектная с тем же
  // id иначе заслоняла общую подгруппу, и её листья терялись (F-186).
  const byId = new Map(
    groups.filter((group) => inClaudeGlobals(group.scope)).map((group) => [group.id, group]),
  );
  const leaves: EntityRef[] = [];
  const seen = new Set<string>();
  const path = new Set<string>();

  const walk = (members: GroupMember[], scope: GroupScope | undefined, depth: number): void => {
    if (depth > MAX_GROUP_DEPTH) return;

    for (const member of members) {
      // Проектный участник и проектная группа целиком тумблер общих каталогов
      // не трогают — ни голый участник (он живёт в проекте, `memberScope`), ни
      // выбранный из общих: иначе включение проектной группы переключило бы
      // одноимённый глобальный скилл, а метки «погашено группой» у него не
      // было бы (`disablingGroups` проектные группы не считает).
      // Копия для другой CLI — то же: её участники — файлы той CLI.
      if (!inClaudeGlobals(scope) || (member.scope && !inClaudeGlobals(member.scope))) continue;
      if (member.kind === 'group') {
        // Уже на текущей ветке — это цикл, глубже не идём.
        if (path.has(member.id)) continue;
        const sub = byId.get(member.id);
        if (!sub || !inClaudeGlobals(sub.scope)) continue;
        path.add(member.id);
        walk(sub.members, sub.scope, depth + 1);
        path.delete(member.id);
        continue;
      }

      const key = `${member.kind} ${member.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      leaves.push({ kind: member.kind, id: member.id });
    }
  };

  walk(root, rootScope, 0);
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
