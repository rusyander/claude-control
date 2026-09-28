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

/**
 * Затравка окна группы: когда поля берутся заново из группы.
 *
 * По идентификатору, а не по объекту: во время прогона вид перечитывается
 * каждые 2 с и приносит НОВЫЙ объект той же группы (сменились статусы кейсов),
 * и перезаполнение по нему стирало название, которое человек как раз набирал.
 * Закрытое окно затравки не имеет — следующее открытие заполнит заново.
 */
export function groupFormSeed(
  isOpen: boolean,
  group: Pick<ProjectTestGroup, 'id'> | undefined,
): string | undefined {
  if (!isOpen) return undefined;
  return group ? `edit:${group.id}` : 'new';
}
