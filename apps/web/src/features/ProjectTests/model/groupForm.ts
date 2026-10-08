import type { ProjectTestGroup } from '@agentdeck/contracts';

/**
 * Группа, которая уже носит этот идентификатор, — или ничего.
 *
 * Сервер заводит группу идемпотентно: на занятый id он молча отдаёт
 * существующую, и окно «Новая группа» закрывалось так, будто создало новую.
 * Отказ с именем занявшей группы нужен здесь, до запроса.
 */
export function takenGroup(
  groups: readonly ProjectTestGroup[],
  id: string,
): ProjectTestGroup | undefined {
  const wanted = id.trim().toLowerCase();
  return groups.find((group) => group.id === wanted);
}
