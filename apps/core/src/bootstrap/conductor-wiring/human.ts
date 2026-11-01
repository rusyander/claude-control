import { applyCleanup, decideCleanup } from '../../conductor/cleanup/cleanup.ts';
import type { CleanupPoint } from '../../conductor/cleanup/cleanup.types.ts';
import { pendingDeliveries } from '../../conductor/human/deliver.ts';
import { noteExternalEdits } from '../../conductor/human/external-edits.ts';
import type { HumanLedger } from '../../conductor/human/human.types.ts';
import { closeLaunchAsks } from '../../conductor/human/launch-ask.ts';
import { readHumanLedger } from '../../conductor/human/ledger.ts';
import { applyAskUpkeep, decideAskUpkeep } from '../../conductor/human/upkeep.ts';
import { writeFinalReport } from '../../conductor/report/report.ts';
import type { BriefSection, ConductorHooks } from '../../conductor/run/run.types.ts';
import type { LiveTask } from '../../journal/resume.ts';
import { statusSnapshot, type StatusSnapshot } from '../../platform/git/status.ts';
import type { ConductorWiringDeps } from './conductor-wiring.types.ts';

/**
 * Зона E этапа 4 — человек: уход за вопросами (напоминания, срок, снятие), ручные правки в копии
 * (снимок на конце хода и шага, сверка перед шагом), доставка сообщений и ответов на границе
 * хода, уборка на конце единицы и задачи, итоговый отчёт.
 *
 * Доставку пишет исполнитель: крючок отдаёт `send`, строку `message.delivered` исполнитель пишет
 * после отправки (`recordDelivery`), поэтому повтор крючка до строки вернёт то же — не потеряет.
 * Основа сверки правок живёт в памяти: после краха первая сверка единицы — снова основа (правка,
 * сделанная ровно в окно краха, не названа; лишней не будет).
 */

export interface HumanHooksOptions {
  now?: () => number;
  status?: typeof statusSnapshot;
}

export function humanHooks(
  deps: ConductorWiringDeps,
  options: HumanHooksOptions = {},
): ConductorHooks {
  const now = options.now ?? Date.now;
  const status = options.status ?? statusSnapshot;
  const bases = new Map<string, StatusSnapshot | null>();

  const live = (taskId: string): LiveTask | undefined => deps.registry.live(taskId);

  const upkeep = (task: LiveTask, taskEnded = false): HumanLedger => {
    const ledger = readHumanLedger(task);
    applyAskUpkeep(task, ledger, decideAskUpkeep(ledger, now(), taskEnded));
    return ledger;
  };

  /** Снимок-основа: копия такая, какой её оставила сессия; сверки здесь нет. */
  const rebase = async (unitId: string, copyDir: string | null): Promise<void> => {
    if (!copyDir) return;
    const read = await status(copyDir, bases.get(unitId) ?? null);
    if ('value' in read) bases.set(unitId, read.value);
  };

  const cleanup = async (task: LiveTask, at: CleanupPoint): Promise<void> => {
    const got = await applyCleanup(task, decideCleanup(readHumanLedger(task), at));
    if (got.leaks.length > 0 || got.skipped.length > 0) {
      deps.note('human.cleanup', { taskId: task.taskId, at: at.kind, ...got });
    }
  };

  return {
    async preStep(s) {
      const task = live(s.taskId);
      if (!task) return { verdict: { ok: true }, sections: [] };
      upkeep(task);
      // Страховка краха между запуском и закрытием пункта 10: задача уже не ждёт запуска.
      if (task.state.task !== 'awaiting-launch') closeLaunchAsks(task, { splitId: null });
      const sections: BriefSection[] = [];
      if (s.copyDir) {
        const prev = bases.get(s.unitId) ?? null;
        const read = await status(s.copyDir, prev);
        const noted = noteExternalEdits(task, { unitId: s.unitId, stepId: s.stepId }, prev, read);
        bases.set(s.unitId, noted.base);
        sections.push(...noted.sections);
      }
      return { verdict: { ok: true }, sections };
    },

    async onTurnEnd(s) {
      const task = live(s.taskId);
      if (!task) return { send: [] };
      const ledger = upkeep(task);
      await rebase(s.unitId, s.copyDir);
      return { send: pendingDeliveries(ledger, s.stepId) };
    },

    async postStep(s) {
      const task = live(s.taskId);
      if (task) {
        // Шаг сдал работу: его открытые вопросы больше никого не держат.
        const ledger = readHumanLedger(task);
        const acts = Object.values(ledger.asks)
          .filter((a) => a.stepId === s.stepId && a.state === 'open')
          .map((a) => ({
            kind: 'withdraw' as const,
            askId: a.askId,
            stepId: s.stepId,
            reason: 'step reported done',
          }));
        applyAskUpkeep(task, ledger, acts);
      }
      await rebase(s.unitId, s.copyDir);
      return { verdict: { ok: true }, facts: {} };
    },

    async onUnitEnd(u) {
      bases.delete(u.unitId);
      const task = live(u.taskId);
      if (!task) return;
      upkeep(task);
      await cleanup(task, { kind: 'unit-end', unitId: u.unitId });
    },

    async onTaskEnd(taskId, at) {
      const task = live(taskId);
      if (!task) return;
      upkeep(task, at === 'ended');
      if (at === 'ended') await cleanup(task, { kind: 'task-end' });
      writeFinalReport(task, { at, ended: task.state.ended });
    },
  };
}
