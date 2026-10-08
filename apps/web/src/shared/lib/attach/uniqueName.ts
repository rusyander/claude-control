/**
 * Имя, не совпадающее с уже приложенными: `shot.png` второй раз — `shot-2.png`.
 * Модель видит картинки по порядку и строку имён; два одинаковых имени в ней не
 * различить, а человеку не понять, какой чип убирает.
 */
export function uniqueName(name: string, taken: ReadonlySet<string>): string {
  if (!taken.has(name)) return name;
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  for (let index = 2; ; index += 1) {
    const candidate = `${stem}-${index}${ext}`;
    if (!taken.has(candidate)) return candidate;
  }
}
