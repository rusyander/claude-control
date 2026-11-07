import { readJournalLines } from '../../journal/read-lines.ts';
import type { LiveTask } from '../../journal/resume.ts';
import type { GitOptions } from '../../platform/git/git.types.ts';
import {
  headOutsideIntegration,
  INTEGRATION_CONFLICT_SIGNAL,
  remergeIntegration,
} from '../copy/integration-base.ts';
import { unitCopyOf } from '../copy/index.ts';
import type { BriefSection, ConductorHooks, HookVerdict } from '../run/run.types.ts';
import { integrationOf, isIntegrationUnit } from './integrated.ts';

/**
 * Конфликт интеграции решается в задаче (этап 11, W3-18b): слияние голов единиц, давшее конфликт,
 * не закрывает единицу интеграции — её шаг `integration-gate` красный с названными файлами и парой
 * веток, единицы ждут (ворота `integrated`), ни одна не публикуется. Каждый заход шага сливает
 * головы заново: правка ветки единицы (конфликт снят) — копия ложится, ворота зелёные, единицы
 * публикуются по рёбрам. Круги шага ограничены пределом (точка 6), ответ «ещё круг» даёт новый.
 */

const FROM = 'conductor/gates/integration';
export const INTEGRATION_GATE_STEP = 'integration-gate';
export const INTEGRATION_CONFLICT_CODE = 'integration-conflict';

export interface IntegrationConflict {
  files: string[];
  between: string[];
}

/** Последний записанный конфликт слияния голов единицы интеграции; нет — `null`. */
export function integrationConflictOf(task: LiveTask, unitId: string): IntegrationConflict | null {
  let found: IntegrationConflict | null = null;
  for (const line of readJournalLines(task.dir, task.taskId).lines) {
    if (line.kind !== 'signal' || line.unitId !== unitId) continue;
    const data = line.data as { signal?: string; detail?: string };
    if (data.signal !== INTEGRATION_CONFLICT_SIGNAL || typeof data.detail !== 'string') continue;
    try {
      const got = JSON.parse(data.detail) as Partial<IntegrationConflict>;
      found = { files: got.files ?? [], between: got.between ?? [] };
    } catch {
      found = { files: [], between: [] };
    }
  }
  return found;
}

export function conflictText(c: IntegrationConflict): string {
  return `integration conflict in ${c.files.join(', ') || 'unnamed files'} between ${c.between.join(' + ') || 'the unit heads'}`;
}

/**
 * Старт единицы интеграции без копии: конфликт голов записан — единица идёт (шаг ворот красный,
 * пока конфликт не снят), раздел брифа его называет. Не интеграция или конфликта нет — `null`.
 */
export function integrationStartOf(task: LiveTask, unitId: string): BriefSection | null {
  if (!isIntegrationUnit(task.state.units[unitId])) return null;
  const conflict = integrationConflictOf(task, unitId);
  if (!conflict) return null;
  return {
    id: 'copy-setup',
    text: `${conflictText(conflict)}: no integration copy yet. Resolve it on a unit branch; the integration gate merges the heads again on every round.`,
    from: FROM,
  };
}

export interface IntegrationHooksDeps {
  live(taskId: string): LiveTask | undefined;
  /** Копия единицы (`copy-wiring.prepare`): заново сливает головы, пока копии нет. */
  prepare(taskId: string, unitId: string): Promise<unknown>;
  /** git слияния голов и сверки покрытия (окружение стенда в тестах); нет — окружение процесса. */
  git?: GitOptions;
}

export function integrationHooks(deps: IntegrationHooksDeps): ConductorHooks {
  return {
    async postStep(s) {
      const quiet = { verdict: { ok: true } as HookVerdict, facts: {} };
      if (s.def.id !== INTEGRATION_GATE_STEP) return quiet;
      const task = deps.live(s.taskId);
      if (!task || !isIntegrationUnit(task.state.units[s.unitId])) return quiet;
      const laid = unitCopyOf(task, s.unitId);
      if (laid) {
        // Копия уже лежит (круг после зелёного, Q-1): головы сливаются заново — проверка и ревью
        // идут над тем, что уйдёт сейчас, а не над слиянием прошлого круга.
        const moved = await remergeIntegration(task, s.unitId, laid, deps.git);
        if (moved.ok) return quiet;
        const conflict = integrationConflictOf(task, s.unitId);
        const named = conflict !== null && moved.reason.startsWith(INTEGRATION_CONFLICT_CODE);
        return red(named ? conflictText(conflict) : moved.reason);
      }
      await deps.prepare(s.taskId, s.unitId);
      if (unitCopyOf(task, s.unitId)) return quiet;
      const conflict = integrationConflictOf(task, s.unitId);
      return red(conflict ? conflictText(conflict) : 'the integration copy was not laid out');
    },
    /**
     * Публикация единицы с интеграцией (P135, Q-1): голова её ветки должна быть в последнем
     * зелёном слиянии. Сдвинулась после него — отказ `reintegrate`: интеграция идёт новым кругом,
     * публикация ждёт его зелёного. Покрыта — ответа нет, публикует публикатор.
     */
    async onPublish(s) {
      const task = deps.live(s.taskId);
      if (!task) return null;
      const found = integrationOf(task.state, s.unitId);
      if (!found) return null;
      const outside = await headOutsideIntegration(task, s.unitId, found[0], deps.git);
      return outside ? { kind: 'refused', next: 'reintegrate', unmet: [outside] } : null;
    },
  };
}

function red(reason: string): { verdict: HookVerdict; facts: Record<string, unknown> } {
  return {
    verdict: { ok: false, stop: 'step', code: INTEGRATION_CONFLICT_CODE, reason },
    facts: {},
  };
}
