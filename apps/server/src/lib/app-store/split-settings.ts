import {
  SPLIT_MAX_GROUPS,
  SPLIT_SETTINGS_DEFAULT,
  type SplitSettings,
} from '@agentdeck/contracts/task-split';
import type { AppState } from './app-store.types.ts';
import { normalizeProjectPath } from './projects.ts';

/**
 * Разделение на проекте: доставка групп до MR и сколько их идёт разом.
 *
 * Ключ — нормализованный путь основной копии, как у зеркала копий. Хранится
 * только отклонение от умолчания: запись, совпавшая с ним, удаляется.
 */

export function getSplitSettings(state: AppState, path: string): SplitSettings {
  const stored = state.splitSettings?.[normalizeProjectPath(path)];
  return { ...SPLIT_SETTINGS_DEFAULT, ...stored };
}

export function setSplitSettings(
  state: AppState,
  path: string,
  settings: SplitSettings,
): SplitSettings {
  const key = normalizeProjectPath(path);
  const next: SplitSettings = {
    deliver: settings.deliver,
    parallel: Math.min(SPLIT_MAX_GROUPS, Math.max(1, Math.round(settings.parallel))),
  };
  state.splitSettings ??= {};
  if (
    next.deliver === SPLIT_SETTINGS_DEFAULT.deliver &&
    next.parallel === SPLIT_SETTINGS_DEFAULT.parallel
  ) {
    delete state.splitSettings[key];
  } else {
    state.splitSettings[key] = next;
  }
  return { ...next };
}
