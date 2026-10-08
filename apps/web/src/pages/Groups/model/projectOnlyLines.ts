import { projectName } from './projectName';

/**
 * Участники, чей файл лежит только в `.claude` привязанного проекта, — по строке
 * на проект: «Только в проекте shop …: rule-incident-capture».
 */
export function projectOnlyLines(
  members: readonly { id: string; foundIn?: string }[],
  line: (project: string, names: string, count: number) => string,
): string[] {
  // Один проект — одна строка, как бы ни был записан путь (`C:\x` и `c:/x`).
  const byProject = new Map<string, { path: string; ids: string[] }>();
  for (const member of members) {
    if (!member.foundIn) continue;
    const key = member.foundIn.replaceAll('\\', '/').toLowerCase();
    const known = byProject.get(key) ?? { path: member.foundIn, ids: [] };
    byProject.set(key, { ...known, ids: [...known.ids, member.id] });
  }
  return [...byProject.values()].map(({ path, ids }) =>
    line(projectName(path), ids.join(', '), ids.length),
  );
}
