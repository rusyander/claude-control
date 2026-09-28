/**
 * Путь к файлу внутри проекта — тем же разделителем, каким записан корень.
 *
 * Корень приходит из реестра как его ввёл человек: `C:\work\shop` или
 * `/home/u/shop`. Строка источника на вкладке называет файл, по которому
 * человек пойдёт руками, и смесь `C:\work\shop/.mcp.json` читалась бы как
 * опечатка.
 */
export function projectFilePath(root: string, ...parts: string[]): string {
  const separator = root.includes('\\') && !root.includes('/') ? '\\' : '/';
  const trimmed = root.replace(/[\\/]+$/, '');
  return [trimmed, ...parts].join(separator);
}
