import type { ProjectCodeLayout, ProjectCodeView } from '@claude-control/contracts';
import { PROJECT_CODE_TREE_DEFAULT, clampTreeWidth } from '@claude-control/contracts/project-code';
import type { AppState } from './app-store.types.ts';
import { normalizeProjectPath } from './projects.ts';

/**
 * Что открыто в окне кода у таба проекта: дерево, файл, режимы показа.
 *
 * Хранится здесь, а не в браузере, намеренно: у панели уже есть свой файл
 * состояния, и запись в нём переживает и чистку кэша, и переход в другой
 * браузер. Ключ — нормализованный путь проекта, он же идентификатор таба.
 */

/** Пусто — таб ещё не открывали; клиент получит собственные умолчания. */
export function getCodeView(state: AppState, path: string): ProjectCodeView | undefined {
  return state.projectCodeViews[normalizeProjectPath(path)];
}

/**
 * Запомнить снимок. Список раскрытых папок урезается: дерево большого
 * репозитория можно раскрыть до тысяч узлов, а восстанавливать имеет смысл
 * рабочую глубину, а не всё, что когда-либо разворачивали.
 */
const MAX_OPEN_DIRS = 200;

export function setCodeView(state: AppState, path: string, view: ProjectCodeView): void {
  state.projectCodeViews[normalizeProjectPath(path)] = {
    file: view.file || undefined,
    openDirs: view.openDirs.slice(0, MAX_OPEN_DIRS),
    showDiff: view.showDiff,
    onlyChanged: view.onlyChanged,
  };
}

/** Таб закрыли — забываем всё, что за ним стояло. */
export function forgetCodeView(state: AppState, path: string): boolean {
  const key = normalizeProjectPath(path);
  if (!(key in state.projectCodeViews)) return false;
  delete state.projectCodeViews[key];
  return true;
}

/**
 * Раскладка окна — одна на панель, без ключа проекта: ширину списка файлов
 * человек настраивает под себя, а не под репозиторий, и ждёт её везде.
 */
export function getCodeLayout(state: AppState): ProjectCodeLayout {
  return {
    treeWidth: clampTreeWidth(state.projectCodeLayout?.treeWidth ?? PROJECT_CODE_TREE_DEFAULT),
  };
}

/** Клиенту на слово не верим: ширина приходит из перетаскивания мышью. */
export function setCodeLayout(state: AppState, layout: ProjectCodeLayout): void {
  state.projectCodeLayout = { treeWidth: clampTreeWidth(layout.treeWidth) };
}
