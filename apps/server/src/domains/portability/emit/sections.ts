import { buildPlan } from './context.ts';
import { emitInstructionsLayer } from './write-instructions.ts';
import { emitConfigLayers } from './write-config.ts';
import { emitFileLayers } from './write-files.ts';
import { emitPermissionsLayer } from './write-permissions.ts';
import { emitPluginsLayer } from './write-plugins.ts';
import type { EmitDeps, EmitPlan } from './types.ts';
import type { AgentEnvironment } from '@agentdeck/contracts/portable-env';

/**
 * Канон → файлы ОДНОЙ цели: этапы, одинаковые по имени у всех девяти чужих CLI.
 *
 * Это НЕ «общий файл для похожих провайдеров»: у каждого CLI свой файл в
 * `emit/`, и он решает, какие этапы звать и что добавить сверх общего (§5.3
 * плана). Здесь лежат ЭТАПЫ; различает провайдеров каталог возможностей, а не
 * ветка по идентификатору.
 *
 * ГЛАВНОЕ РЕШЕНИЕ СЛОЯ: уровень верности здесь не вычисляется заново. Приговор
 * выносит `fidelity.ts` (волна П1), а эмиттер его ИСПОЛНЯЕТ — `native` пишет
 * родным адаптером цели, `text` сливает в инструкции, `emulated`/`wired`
 * оставляет рантайму (П3/П4), `impossible` называет вслух. Вторая таблица
 * «запись → что с ней делать» здесь и была бы той самой матрицей, которая
 * начинает лгать на одиннадцатом CLI.
 *
 * Caveat: у Claude этих этапов нет вовсе (`emit/claude.ts`) — его разделы
 * собственные и богатые, и универсальные адаптеры их не видят. Общего у двух
 * наборов ровно каркас плана (`context.ts`): приговоры, строка на запись,
 * рантайм последним этапом.
 */

/** Собрать план эмиссии по всем универсальным слоям цели. */
export function emitUniversalSections(env: AgentEnvironment, deps: EmitDeps): EmitPlan {
  return buildPlan(env, deps, [
    emitInstructionsLayer,
    emitFileLayers,
    emitConfigLayers,
    emitPermissionsLayer,
    emitPluginsLayer,
  ]);
}
