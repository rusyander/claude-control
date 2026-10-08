/**
 * Попадает ли открытый файл под удаление. Проверяем не только сам путь, но и
 * вложенность: удалили папку — открытый внутри неё файл тоже исчез, и держать
 * его в редакторе нельзя, иначе правка уйдёт в несуществующий путь.
 */
export function isRemovedByDelete(selected: string | undefined, deletedPath: string): boolean {
  if (!selected) return false;
  return selected === deletedPath || selected.startsWith(`${deletedPath}/`);
}
