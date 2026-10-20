import { normalizeProjectPath } from './workspace';

/**
 * Один ли это каталог: разделители и хвостовой слэш не в счёт, а регистр — только
 * у путей Windows (с буквой диска): там он не различается, а на Linux/macOS
 * `App` и `app` — два разных каталога.
 */
export function samePath(a: string, b: string): boolean {
  return normalizeProjectPath(a) === normalizeProjectPath(b);
}
