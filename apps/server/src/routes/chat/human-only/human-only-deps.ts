import { liveCliPids } from '../../../lib/cli-spawn/live-cli-pids.ts';
import type { HumanOnlyDeps } from './human-only.ts';
import type { PanelDirs } from './throwaway-stand.ts';

interface RootSource {
  allProcessRoots(): number[];
}

/**
 * Реестры прогонов этого процесса: маршруты решений вне чата (настройки, чат
 * чужого CLI) реестра не получают, а прогоны, подхваченные из журнала после
 * перезапуска, панель сама не запускала — их номера знает только реестр.
 */
const registries = new Set<RootSource>();

/**
 * Каталоги панели для шва одноразового стенда. Задаёт их сборка маршрутов
 * (`gateHumanRoutesFor`) из контекста сервера; не заданы — шва нет, и ворота
 * строгие (сборка маршрутов в тесте без контекста).
 */
let panelDirs: (() => PanelDirs | undefined) | undefined;

export function setPanelDirs(source: (() => PanelDirs | undefined) | undefined): void {
  panelDirs = source;
}

/**
 * Корни процессов модели для `humanOnly`: каждый живой CLI, запущенный панелью
 * (чат, агент панели, чужой CLI, агент тестов), и прогоны всех реестров.
 */
export function humanOnlyDepsFor(registry?: RootSource): HumanOnlyDeps {
  if (registry) registries.add(registry);
  return {
    roots: () => {
      const roots = new Set(liveCliPids());
      for (const source of registries) {
        for (const pid of source.allProcessRoots()) roots.add(pid);
      }
      return [...roots];
    },
    panelDirs: () => panelDirs?.(),
  };
}
