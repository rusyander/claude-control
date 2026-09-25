import {
  SPLIT_MAX_GROUPS,
  SPLIT_SETTINGS_DEFAULT,
  type StoredSplitSettings,
} from '@agentdeck/contracts/task-split';
import {
  pickGroupPermissions,
  resolveSplitDefaults,
  SPLIT_DEFAULTS_BUILTIN,
  type GroupPermissionLevel,
  type SplitDefaults,
  type StoredSplitDefaults,
} from '@agentdeck/contracts/split-groups';
import type { AppState } from './app-store.types.ts';
import { normalizeProjectPath } from './projects.ts';

/**
 * Разделение на проекте: доставка групп до MR, сколько их идёт разом и какие
 * запросы группы панель решает сама.
 *
 * Ключ — нормализованный путь основной копии, как у зеркала копий. Хранится
 * только отклонение от умолчания: запись, совпавшая с ним, удаляется. Число
 * групп разом не задано — берётся из общих правил по тяжести проекта
 * (`domains/project-git/delivery.ts`), поэтому его в записи может не быть.
 *
 * Общие правила вкладки «Группы» лежат рядом (`splitDefaults`), тоже одним
 * отклонением от коробки. Прежние записи проектов (`deliver` + `parallel`)
 * читаются как есть: их поля не менялись, а разрешений в них нет — значит,
 * проект наследует общие.
 */

export function getSplitSettings(state: AppState, path: string): StoredSplitSettings {
  const stored = state.splitSettings?.[normalizeProjectPath(path)];
  const deliver =
    typeof stored?.deliver === 'boolean' ? stored.deliver : SPLIT_SETTINGS_DEFAULT.deliver;
  const permissions = pickGroupPermissions(stored?.permissions);
  return {
    deliver,
    ...(typeof stored?.parallel === 'number' ? { parallel: stored.parallel } : {}),
    ...(Object.keys(permissions).length > 0 ? { permissions } : {}),
  };
}

export function setSplitSettings(
  state: AppState,
  path: string,
  settings: {
    deliver: boolean;
    parallel?: number | null;
    /** Не задано — строки проекта не трогаем; `null` — сбросить к общим. */
    permissions?: Record<string, GroupPermissionLevel | boolean> | null;
  },
): StoredSplitSettings {
  const key = normalizeProjectPath(path);
  const next: StoredSplitSettings = { deliver: settings.deliver };
  if (typeof settings.parallel === 'number') {
    next.parallel = Math.min(SPLIT_MAX_GROUPS, Math.max(1, Math.round(settings.parallel)));
  }
  // Тумблер «До MR» в шапке чата шлёт только доставку и число: его сохранение
  // не должно молча стирать строки разрешений, заданные во вкладке «Группы».
  const permissions =
    settings.permissions === undefined
      ? pickGroupPermissions(state.splitSettings?.[key]?.permissions)
      : pickGroupPermissions(settings.permissions ?? undefined);
  if (Object.keys(permissions).length > 0) next.permissions = permissions;
  state.splitSettings ??= {};
  if (
    next.deliver === SPLIT_SETTINGS_DEFAULT.deliver &&
    next.parallel === undefined &&
    next.permissions === undefined
  ) {
    delete state.splitSettings[key];
  } else {
    state.splitSettings[key] = structuredClone(next);
  }
  return structuredClone(next);
}

/** Общие правила групп — действующие, хранимое поверх коробки. */
export function getSplitDefaults(state: AppState): SplitDefaults {
  return resolveSplitDefaults(state.splitDefaults);
}

/**
 * Записать общие правила. Хранится только отличие от коробки: так смена
 * коробки в новой версии (скажем, другой потолок из коробки) доходит до тех,
 * кто это поле не трогал.
 */
export function setSplitDefaults(state: AppState, input: StoredSplitDefaults): SplitDefaults {
  const value = resolveSplitDefaults(input);
  const base = SPLIT_DEFAULTS_BUILTIN;
  const stored: StoredSplitDefaults = {};
  const permissions = Object.fromEntries(
    Object.entries(value.permissions).filter(
      ([id, on]) => base.permissions[id as keyof typeof base.permissions] !== on,
    ),
  );
  if (Object.keys(permissions).length > 0) stored.permissions = permissions;
  if (value.groupQuestions !== base.groupQuestions) stored.groupQuestions = value.groupQuestions;
  if (value.parallelLight !== base.parallelLight) stored.parallelLight = value.parallelLight;
  if (value.parallelHeavy !== base.parallelHeavy) stored.parallelHeavy = value.parallelHeavy;
  const heavy: Partial<SplitDefaults['heavy']> = {};
  if (value.heavy.chains !== base.heavy.chains) heavy.chains = value.heavy.chains;
  if (value.heavy.steps !== base.heavy.steps) heavy.steps = value.heavy.steps;
  if (Object.keys(heavy).length > 0) stored.heavy = heavy;
  if (Object.keys(stored).length > 0) state.splitDefaults = stored;
  else delete state.splitDefaults;
  return value;
}
