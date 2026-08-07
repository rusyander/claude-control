import { renameSync } from 'node:fs';
import { join } from 'node:path';
import { readJsonFile } from '../safe-io.ts';
import { DEFAULT_STATE } from './app-store.constants.ts';
import type { AppState } from './app-store.types.ts';

/** Файл состояния панели внутри каталога её данных. */
export function stateFilePath(appDataDir: string): string {
  return join(appDataDir, 'state.json');
}

/**
 * Слить прочитанное с дефолтами — одинаково при загрузке с диска и при импорте
 * чужого снимка: файл может быть неполным или из старой версии, а панель не
 * должна на нём падать.
 *
 * Дефолт клонируем целиком. Иначе при пустом state.json вложенные массивы
 * (groups, automations, disabled.hook и т.д.) остаются ОБЩЕЙ ссылкой с
 * модульным DEFAULT_STATE, и мутации одного стора (setEnabled/saveGroup)
 * протекают в другие экземпляры и в сам дефолт — а экземпляров несколько
 * (песочницы, смена целевого каталога через claudeDirOverride).
 */
export function mergeState(loaded: Partial<AppState>): AppState {
  const base = structuredClone(DEFAULT_STATE);
  return {
    ...base,
    ...loaded,
    disabled: { ...base.disabled, ...loaded.disabled },
    disabledByGroup: { ...base.disabledByGroup, ...loaded.disabledByGroup },
    disabledHooks: { ...base.disabledHooks, ...loaded.disabledHooks },
    envByGroup: { ...base.envByGroup, ...loaded.envByGroup },
    projects: loaded.projects ?? base.projects,
    runnerCommands: { ...base.runnerCommands, ...loaded.runnerCommands },
    runnerPrefs: { ...base.runnerPrefs, ...loaded.runnerPrefs },
    providerChecks: { ...base.providerChecks, ...loaded.providerChecks },
    projectCodeViews: { ...base.projectCodeViews, ...loaded.projectCodeViews },
    settings: { ...base.settings, ...loaded.settings },
  };
}

/**
 * Прочитать state.json, пережив испорченный файл.
 *
 * Разбор бросает на оборванном или изуродованном JSON (выключили питание
 * посреди записи, руками правили файл), а вызывается это на старте сервера —
 * исключение отсюда означало «панель не запускается вовсе, и починить её нечем,
 * потому что интерфейс не поднялся». Поэтому битый файл отодвигаем в сторону
 * под именем `state.corrupt.json` (не удаляем: там группы и сценарии
 * пользователя, их ещё можно вытащить руками) и стартуем с дефолтов.
 */
export function readStateFile(appDataDir: string): Partial<AppState> {
  const stateFile = stateFilePath(appDataDir);
  try {
    return readJsonFile<Partial<AppState>>(stateFile, {});
  } catch (error) {
    const parked = join(appDataDir, 'state.corrupt.json');
    try {
      renameSync(stateFile, parked);
    } catch {
      // Переименовать не вышло (файл занят, нет прав) — это не повод не
      // запуститься: дальше работаем на дефолтах, первая же запись перезапишет.
    }
    process.stderr.write(
      `state.json не читается (${(error as Error).message}); файл отложен в ${parked}, настройки взяты по умолчанию\n`,
    );
    return {};
  }
}
