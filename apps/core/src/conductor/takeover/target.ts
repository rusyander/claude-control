import { STEP_MACHINE } from '@agentdeck/contracts/core/states';
import type { LiveTask } from '../../journal/resume.ts';
import { publicationOf } from '../../journal/reduce/publish.ts';
import type { TaskFoldState } from '../../journal/reduce/reduce.types.ts';
import { unitCopyOf } from '../copy/journal-view.ts';

/**
 * Чью единицу берёт человек и куда идёт слово доработки (этап 12, D9 D10). Только журнал задачи:
 * памяти процесса нет, повтор после перезапуска выбирает то же.
 */

const terminal = (state: string): boolean =>
  (STEP_MACHINE.terminal as readonly string[]).includes(state);

/**
 * Последний начатый и не кончившийся шаг задачи (наибольший `startedSeq`): ему — слово человека.
 * Нет такого — `undefined`: сообщение некому доставить.
 */
export function liveStepOf(
  state: TaskFoldState,
  unitId?: string,
): { stepId: string; unitId: string } | undefined {
  let best: { stepId: string; unitId: string; seq: number } | undefined;
  for (const [stepId, step] of Object.entries(state.steps)) {
    if (terminal(step.state)) continue;
    if (unitId !== undefined && step.unitId !== unitId) continue;
    if (!best || step.startedSeq > best.seq)
      best = { stepId, unitId: step.unitId, seq: step.startedSeq };
  }
  return best ? { stepId: best.stepId, unitId: best.unitId } : undefined;
}

/**
 * Единица перехвата: та, чей шаг шёл последним, если у неё живая копия; иначе — любая единица с
 * живой копией (задача стоит между шагами). Копии нет ни у одной — перехватывать нечего: человек
 * правил бы основную папку, а её ядро не отдаёт (06:98).
 */
export function takeoverTargetOf(task: LiveTask): { unitId: string; copy: string } | undefined {
  const live = liveStepOf(task.state);
  const order = [
    ...(live ? [live.unitId] : []),
    ...Object.keys(task.state.units).filter((u) => u !== live?.unitId),
  ];
  for (const unitId of order) {
    const copy = unitCopyOf(task, unitId);
    if (copy) return { unitId, copy: copy.dir };
  }
  return undefined;
}

/**
 * Открытый MR задачи для доработки: личность из `publish.mr`, конца у форжа (`publish.mr-state`)
 * нет. Несколько — первый по порядку единиц (носитель один на доработку, P162).
 */
export function openMrUnitOf(
  state: TaskFoldState,
): { unitId: string; mrIid: number; url: string } | undefined {
  for (const unitId of Object.keys(state.units)) {
    const p = publicationOf(state, unitId);
    if (p.mr && !p.mrState) return { unitId, mrIid: p.mr.mrIid, url: p.mr.url };
  }
  return undefined;
}
