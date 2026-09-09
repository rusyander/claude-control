import type { WorktreeMirrorSettings } from '@agentdeck/contracts';
import type { AppState } from './app-store.types.ts';
import { normalizeProjectPath } from './projects.ts';

/**
 * Что человек дописал к встроенному списку зеркала копий на проекте.
 *
 * Ключ — нормализованный путь основной копии, как у остальных карт по
 * проектам. Хранится только отклонение от умолчания: пустые списки удаляют
 * запись, иначе `state.json` копил бы пустые объекты по каждому репозиторию,
 * где человек открыл поповер копий.
 */

/** Пустые строки и пробелы из формы — это «не задано», а не шаблон. */
function clean(patterns: string[]): string[] {
  const seen = new Set<string>();
  for (const raw of patterns) {
    const value = raw.trim();
    if (value) seen.add(value);
  }
  return [...seen];
}

export function getWorktreeMirror(state: AppState, path: string): WorktreeMirrorSettings {
  const stored = state.worktreeMirror?.[normalizeProjectPath(path)];
  return stored ? structuredClone(stored) : { include: [], exclude: [] };
}

/** Команда бутстрапа без пробелов по краям; пустая — «не задана». */
function cleanCommand(value: string | undefined): string | undefined {
  const text = value?.trim();
  return text ? text : undefined;
}

/** Записать шаблоны и команду; всё пусто — запись уходит. */
export function setWorktreeMirror(
  state: AppState,
  path: string,
  settings: WorktreeMirrorSettings,
): WorktreeMirrorSettings {
  const key = normalizeProjectPath(path);
  const bootstrap = cleanCommand(settings.bootstrap);
  const next: WorktreeMirrorSettings = {
    include: clean(settings.include),
    exclude: clean(settings.exclude),
    ...(bootstrap ? { bootstrap } : {}),
  };
  state.worktreeMirror ??= {};
  if (next.include.length === 0 && next.exclude.length === 0 && !bootstrap) {
    delete state.worktreeMirror[key];
  } else {
    state.worktreeMirror[key] = next;
  }
  return structuredClone(next);
}
