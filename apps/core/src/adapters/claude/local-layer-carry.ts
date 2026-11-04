import type { LayerRun, SessionLayerCarry } from '../adapter.types.ts';
import { keepHumanAllow } from './permission.ts';
import { pluginDirProblem } from './plugin-carry.ts';
import type { HookTable } from './user-layer.ts';

/**
 * Локальный слой проекта в Claude Code (s10 G14 p6): командный слой из копии панели
 * (`.agent/local-layer/build/`) ВМЕСТО источника `project`. Прежний исполнитель панели клал его
 * `--setting-sources` без `project`, `--plugin-dir`, своим `--settings` и дописью к системному
 * промпту; здесь те же части ложатся в сеанс ядра: инструкции — после брифа, плагин — флагом,
 * хуки, права и переменные — в `--settings` ядра (единственный, в нём же запреты ядра).
 *
 * Слой — содержимое РЕПОЗИТОРИЯ, поэтому едет только при слое человека `on` на деле: недоверенная
 * копия (F-86, `on` → `observe`) файлов репозитория не получает, и слой — тоже (отказ по имени, а
 * не тихо урезанный сеанс). С источником `project` слой задвоил бы командные файлы — отказ.
 */

export function localLayerRefusal(
  carry: SessionLayerCarry | undefined,
  layer: Pick<LayerRun, 'asked' | 'ran'>,
): string | null {
  const local = carry?.localLayer;
  if (!local) return null;
  if (layer.ran !== 'on') {
    return (
      `session-carry-local-layer-needs-layer-on: the project layer is repository content, ` +
      `this step runs the human layer '${layer.ran}'` +
      (layer.asked === 'on' ? ' (folder not trusted)' : '')
    );
  }
  const sources = carry?.settingSources;
  if (!sources || sources.includes('project')) {
    return (
      'session-carry-local-layer-with-project: the local layer replaces the project setting ' +
      'source, the session must narrow setting sources without project'
    );
  }
  // Своё имя, а не `session-carry-plugin` набора: панель называет человеку сборку слоя, а не набор.
  if (local.plugin) {
    const problem = pluginDirProblem(local.plugin);
    if (problem) return `session-carry-local-layer-plugin: ${problem}`;
  }
  return null;
}

export interface LocalLayerSettings {
  allow: string[];
  ask: string[];
  deny: string[];
  hooks: HookTable;
  env: Record<string, string>;
}

/** Части `--settings` из слоя; `allow` — тем же фильтром, что права человека (F-35). */
export function localLayerSettings(carry: SessionLayerCarry | undefined): LocalLayerSettings {
  const local = carry?.localLayer;
  return {
    allow: (local?.permissions?.allow ?? []).filter(keepHumanAllow),
    ask: [...(local?.permissions?.ask ?? [])],
    deny: [...(local?.permissions?.deny ?? [])],
    hooks: (local?.hooks ?? {}) as HookTable,
    env: { ...(local?.env ?? {}) },
  };
}
