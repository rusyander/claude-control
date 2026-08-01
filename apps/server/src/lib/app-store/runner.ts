import type { AppState, RunnerPrefs, RunnerTargetMeta } from './app-store.types.ts';
import { normalizeProjectPath } from './projects.ts';

/**
 * Оверрайд команды запуска для каталога цели (или undefined, если не задан).
 *
 * Читается и из старой карты `runnerCommands`: до появления подпапок оверрайд
 * жил там, и терять его при обновлении панели незачем. Запись всегда идёт
 * в `runnerPrefs` — старая карта только дочитывается.
 */
export function getRunnerCommand(state: AppState, path: string): string | undefined {
  const key = normalizeProjectPath(path);
  return state.runnerPrefs[key]?.command || state.runnerCommands[key] || undefined;
}

/** Сохранить/очистить оверрайд команды запуска для каталога цели. */
export function setRunnerCommand(
  state: AppState,
  path: string,
  command: string | undefined,
  meta: RunnerTargetMeta,
): void {
  const trimmed = command?.trim();
  updateRunnerPrefs(state, path, meta, (prefs) => {
    if (trimmed) prefs.command = trimmed;
    else delete prefs.command;
  });
  // Старая запись больше не нужна: значение переехало в runnerPrefs.
  delete state.runnerCommands[normalizeProjectPath(path)];
}

/** Что панель помнит о запуске этой цели (пусто — ничего). */
export function getRunnerPrefs(state: AppState, path: string): RunnerPrefs | undefined {
  return state.runnerPrefs[normalizeProjectPath(path)];
}

/**
 * Включить/выключить автозапуск цели. Выключение НЕ забывает ни порт, ни
 * команду: тумблер вернут — всё останется прежним.
 */
export function setRunnerAutostart(
  state: AppState,
  path: string,
  autostart: boolean,
  meta: RunnerTargetMeta,
): void {
  updateRunnerPrefs(state, path, meta, (prefs) => {
    if (autostart) prefs.autostart = true;
    else delete prefs.autostart;
  });
}

/**
 * Снять автозапуск со ВСЕХ целей проекта — закрытая вкладка не должна
 * оставлять после себя обещание что-то поднять при следующем старте.
 */
export function clearRunnerAutostart(state: AppState, projectPath: string): void {
  const root = normalizeProjectPath(projectPath);
  for (const [key, prefs] of Object.entries(state.runnerPrefs)) {
    const owner = normalizeProjectPath(prefs.projectPath ?? prefs.path);
    if (owner !== root && key !== root) continue;
    updateRunnerPrefs(state, prefs.path, prefs, (next) => delete next.autostart);
  }
}

/** Закрепить порт цели (или снять закрепление). */
export function setRunnerPort(
  state: AppState,
  path: string,
  port: number | undefined,
  meta: RunnerTargetMeta,
): void {
  updateRunnerPrefs(state, path, meta, (prefs) => {
    if (port && Number.isInteger(port) && port > 0 && port < 65_536) prefs.pinnedPort = port;
    else delete prefs.pinnedPort;
  });
}

/**
 * Запомнить порт удачного запуска — он показывается как подсказка. Возвращает
 * `false`, когда тот же порт уже записан: перезаписывать файл незачем.
 */
export function rememberRunnerPort(
  state: AppState,
  path: string,
  port: number,
  meta: RunnerTargetMeta,
): boolean {
  if (getRunnerPrefs(state, path)?.port === port) return false;
  updateRunnerPrefs(state, path, meta, (prefs) => {
    prefs.port = port;
  });
  return true;
}

/** Цели с включённым автозапуском — их поднимает старт сервера панели. */
export function listAutostartProjects(state: AppState): RunnerPrefs[] {
  return Object.values(state.runnerPrefs).filter((prefs) => prefs.autostart);
}

/**
 * Общая правка записи о цели: запись без единого осмысленного поля удаляется
 * целиком, иначе `state.json` копил бы пустышки от каждого касания.
 * Персист вызывает вызывающий — иначе массовые правки писали бы файл по разу
 * на цель.
 */
function updateRunnerPrefs(
  state: AppState,
  path: string,
  meta: RunnerTargetMeta,
  mutate: (prefs: RunnerPrefs) => void,
): void {
  const key = normalizeProjectPath(path);
  const next: RunnerPrefs = { ...state.runnerPrefs[key], path };
  if (meta.projectPath) next.projectPath = meta.projectPath;
  if (meta.dir) next.dir = meta.dir;
  mutate(next);

  const isEmpty =
    !next.autostart && next.port === undefined && next.pinnedPort === undefined && !next.command;
  if (isEmpty) delete state.runnerPrefs[key];
  else state.runnerPrefs[key] = next;
}
