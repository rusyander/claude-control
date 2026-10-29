import { readFileSync } from 'node:fs';
import { parse as parseToml } from 'smol-toml';
import { parse as parseYaml } from 'yaml';

/**
 * Общее у CLI, которые идут в контур только окружением прогона
 * (`ProviderRunEndpoint`): Kimi Code, Goose. Само окружение и имя модели без
 * названия (`contourModelName`) — в пакете `@agentdeck/providers`; здесь только
 * чтение конфига человека для проверки обхода.
 */

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
