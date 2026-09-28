import type { PresetsDictionary } from './presets.types.ts';

/**
 * Заготовки прав, MCP-серверов и хуков. Русский текст второй раз здесь не
 * пишется: он стоит в самой заготовке и уходит в `t()` как `defaultValue`
 * (`../preset-text.ts`), так что две копии не разъедутся. Английский —
 * `en.ts`. Подключён в `../ru.ts` ключом `presets`.
 */
export const presetsRu: PresetsDictionary = {
  permission: {},
  mcp: {},
  hook: {},
  hookEvent: {},
};
