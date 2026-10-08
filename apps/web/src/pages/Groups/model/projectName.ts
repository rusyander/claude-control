/** Короткое имя проекта для карточки: последний сегмент пути, полный — в подсказке. */
export function projectName(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}
