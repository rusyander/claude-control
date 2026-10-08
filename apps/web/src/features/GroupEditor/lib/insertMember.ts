import type { GroupMember } from '@agentdeck/contracts';

/**
 * Выбор участников группы. Группа объединяет сущности разных типов и даже другие
 * группы, поэтому список сводный: правила, скиллы, хуки, серверы и группы в
 * одном месте с фильтром по типу.
 *
 * Порядок участников значим (задаёт порядок обхода), поэтому под списком выбора
 * идёт упорядоченный список выбранного: словами, со стрелками ↑/↓ и «+» между
 * строками — отмеченный после «+» участник встаёт на это место, а не в конец.
 */
export function insertMember(
  value: GroupMember[],
  ref: GroupMember,
  at: number | undefined,
): GroupMember[] {
  if (at === undefined || at >= value.length) return [...value, ref];
  return [...value.slice(0, at), ref, ...value.slice(at)];
}
