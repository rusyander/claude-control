import { dirname, join } from 'node:path';
import type { ProviderHooksInfo } from '@agentdeck/contracts';
import { readTextFile } from '../../lib/safe-io.ts';
import { parseCodexToml } from '../../lib/codex-toml.ts';

/**
 * Что рядом с `hooks.json` Codex меняет судьбу его правил, хотя панель туда не пишет.
 *
 * `config.toml` лежит в том же каталоге (`~/.codex/` или `<проект>/.codex/`) и
 * держит две вещи, о которых молчать нельзя:
 * - рубильник `[features] hooks = false` (устаревшее имя `codex_hooks`) — с ним не
 *   сработает ни одно правило раздела;
 * - таблицы `[[hooks.<Событие>]]` — их Codex грузит ВМЕСТЕ с `hooks.json` (живая
 *   проба: оба источника, с предупреждением). Панель их не правит, но показать,
 *   что хуки есть ещё и там, обязана.
 *
 * Битый `config.toml` раздел хуков не роняет: это чужой файл другого раздела, и
 * его ошибка видна там. Здесь просто нечего сказать.
 */
export function codexHooksSwitches(
  hooksPath: string,
): Pick<ProviderHooksInfo, 'disableAll' | 'alsoDefinedIn'> {
  const configPath = join(dirname(hooksPath), 'config.toml');
  const result: Pick<ProviderHooksInfo, 'disableAll' | 'alsoDefinedIn'> = {};
  let config: Record<string, unknown>;
  try {
    const text = readTextFile(configPath);
    if (!text.trim()) return result;
    config = parseCodexToml(text);
  } catch {
    return result;
  }
  const features = config.features;
  if (features && typeof features === 'object' && !Array.isArray(features)) {
    const flags = features as Record<string, unknown>;
    if (flags.hooks === false || flags.codex_hooks === false) result.disableAll = true;
  }
  const hooks = config.hooks;
  if (hooks && typeof hooks === 'object' && !Array.isArray(hooks)) {
    const events = Object.values(hooks as Record<string, unknown>);
    if (events.some((value) => Array.isArray(value) && value.length > 0)) {
      result.alsoDefinedIn = configPath;
    }
  }
  return result;
}
