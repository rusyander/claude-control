/**
 * Файл, который агент собирался править, — из входа придержанного вызова.
 * Свой CLI зовёт его `file_path` (`notebook_path` у тетрадки), чужие — `path`.
 * Нет пути (команда оболочки, патч) — `undefined`: карточка тогда молчит о
 * файле, а не выдумывает его.
 */
export function gateTarget(input: unknown): string | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const fields = input as Record<string, unknown>;
  for (const key of ['file_path', 'notebook_path', 'path']) {
    const value = fields[key];
    if (typeof value === 'string' && value.trim()) return value;
  }
  return undefined;
}
