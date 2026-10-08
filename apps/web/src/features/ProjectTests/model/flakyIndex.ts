import type { ProjectTestFlakyMarks, ProjectTestFlakyMark } from '@agentdeck/contracts';

/** Отметки нестабильности по ключу строки таблицы — «группа:кейс». */
export function flakyIndex(
  marks: ProjectTestFlakyMarks | undefined,
): Map<string, ProjectTestFlakyMark> {
  return new Map((marks?.cases ?? []).map((mark) => [`${mark.groupId}:${mark.caseId}`, mark]));
}
