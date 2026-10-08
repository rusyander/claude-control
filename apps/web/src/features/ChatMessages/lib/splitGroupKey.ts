/**
 * Ключ строки хаба для звена группы. Номер группы из связи — первым (Д12):
 * ветку, прочитанную из разговора, агент волен сменить (или уйти в detached
 * HEAD), и одна группа распадалась на две строки. Номера нет (связь старше
 * поля) — ветка, затем имя группы, затем сам разговор.
 */
export function splitGroupKey(link: {
  groupIndex?: number | undefined;
  branch?: string | undefined;
  title?: string | undefined;
  id: string;
}): string {
  if (typeof link.groupIndex === 'number') return `#${link.groupIndex}`;
  return link.branch || link.title || link.id;
}
