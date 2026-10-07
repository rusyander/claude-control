import { readFileSync } from 'node:fs';
import { parse as parseToml } from 'smol-toml';
import { parse as parseYaml } from 'yaml';

/**
 * Общее у CLI, которые идут в контур только окружением прогона
 * (`ProviderRunEndpoint`): Kimi Code, Goose, OpenCode.
 */

/**
 * Имя модели, когда контур своей не назвал. Пустым его оставить нельзя: без
 * имени Kimi не заводит модель из окружения и уходит к модели по умолчанию из
 * конфига человека, то есть мимо контура (живая проба 2.1.1). Имя уходит в
 * контур как есть — что с ним делать, решает контур, а не облако вендора.
 */
export const UNNAMED_CONTOUR_MODEL = 'default';

export const contourModelName = (model: string): string => model.trim() || UNNAMED_CONTOUR_MODEL;

/** Корень конфига CLI объектом; нет файла или он не читается — пустой объект. */
export function readConfigRoot(file: string, format: 'toml' | 'yaml'): Record<string, unknown> {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return {};
  }
  try {
    const root: unknown = format === 'toml' ? parseToml(text) : parseYaml(text);
    return root && typeof root === 'object' && !Array.isArray(root)
      ? (root as Record<string, unknown>)
      : {};
  } catch {
    // Битый конфиг не запустит и сам CLI: отказ придёт от него, со строкой.
    return {};
  }
}
