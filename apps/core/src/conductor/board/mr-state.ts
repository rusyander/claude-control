import type { Fact } from '@agentdeck/contracts/core/facts';
import type { ForgeMr } from '@agentdeck/contracts/core/forge';
import { publicationOf } from '../../journal/reduce/publish.ts';
import type { TaskFoldState } from '../../journal/reduce/reduce.types.ts';
import type { TaskRegistry } from '../tasks.ts';
import type { TaskReader } from './read.ts';
import { columnOfTask, isChatTask } from './stage.ts';

/**
 * Обход конца MR (этап 12, B10b, P168): карточка в колонке MR сама не узнает, что MR слили или
 * закрыли у форжа, — её колонку выводит журнал. Обход читает `ForgePort.mr(iid)` ТОЛЬКО у задач
 * колонки MR (не у всего дома: форж платит запросом за каждую) и пишет `publish.mr-state` слитого
 * или закрытого MR — карточка уходит в «Влит»/«Закрыта». Открытый, пропавший или непрочитанный
 * MR ничего не пишет: «форж не ответил» — не «закрыт» (P44), карточка стоит, причина названа.
 */

/** Единица задачи колонки MR, у которой MR есть, а его конца в журнале нет. */
export interface MrTarget {
  taskId: string;
  unitId: string;
  mrIid: number;
  state: TaskFoldState;
}

/** Чтение MR единицы у форжа; одна фабрика на обход — сервер репозитория читается раз на обход. */
export type MrStateReader = (target: MrTarget) => Promise<Fact<ForgeMr>>;

export interface MrStateSweepDeps {
  tasks: TaskReader;
  registry: Pick<TaskRegistry, 'live' | 'open'>;
  reader: () => MrStateReader;
  now: () => number;
  note: (message: string) => void;
}

export interface MrSweepReport {
  read: number;
  written: { taskId: string; unitId: string; state: 'merged' | 'closed' }[];
  /** Единицы без записи: MR открыт, не найден или не прочитан — с причиной. */
  unchanged: { taskId: string; unitId: string; why: string }[];
}

/** Цели обхода: не чат, колонка MR, единица с `publish.mr` без `publish.mr-state`. */
export function mrTargetsOf(states: readonly TaskFoldState[]): MrTarget[] {
  const out: MrTarget[] = [];
  for (const state of states) {
    if (isChatTask(state) || columnOfTask(state) !== 'mr') continue;
    for (const unitId of Object.keys(state.publication)) {
      const pub = publicationOf(state, unitId);
      if (pub.mr && !pub.mrState)
        out.push({ taskId: state.taskId, unitId, mrIid: pub.mr.mrIid, state });
    }
  }
  return out;
}

const why = (fact: Fact<ForgeMr>): string =>
  'unknown' in fact ? fact.unknown : 'absent' in fact ? 'MR not found at the forge' : 'MR open';

export function createMrStateSweep(deps: MrStateSweepDeps) {
  let running: Promise<MrSweepReport> | undefined;

  async function write(target: MrTarget, end: 'merged' | 'closed'): Promise<string | null> {
    const own = deps.registry.live(target.taskId);
    const opened = own ? { task: own } : await deps.registry.open(target.taskId);
    if ('refused' in opened) return `task not opened: ${opened.refused}`;
    const task = opened.task;
    // Пока читали форж, конец мог записать другой путь (команда, второй обход) — строка одна.
    const pub = publicationOf(task.state, target.unitId);
    if (!pub.mr || pub.mr.mrIid !== target.mrIid) return 'MR of the unit changed during the read';
    if (pub.mrState) return null;
    task.append({
      kind: 'publish.mr-state',
      actor: 'core',
      unitId: target.unitId,
      data: { unitId: target.unitId, state: end, at: deps.now() },
    });
    return null;
  }

  async function sweep(): Promise<MrSweepReport> {
    const report: MrSweepReport = { read: 0, written: [], unchanged: [] };
    const { states, problems } = deps.tasks.states();
    for (const p of problems) deps.note(`mr-state: ${p}`);
    const targets = mrTargetsOf(states);
    if (targets.length === 0) return report;
    const read = deps.reader();
    for (const target of targets) {
      const { taskId, unitId } = target;
      report.read += 1;
      let fact: Fact<ForgeMr>;
      try {
        fact = await read(target);
      } catch (error) {
        fact = { unknown: `read failed: ${String(error)}` };
      }
      const end = 'value' in fact ? fact.value.state : null;
      if (end !== 'merged' && end !== 'closed') {
        const reason = why(fact);
        report.unchanged.push({ taskId, unitId, why: reason });
        if (!('value' in fact))
          deps.note(`mr-state ${taskId}/${unitId} !${target.mrIid}: ${reason}`);
        continue;
      }
      let refused: string | null;
      try {
        refused = await write(target, end);
      } catch (error) {
        refused = `append failed: ${String(error)}`;
      }
      if (refused) {
        report.unchanged.push({ taskId, unitId, why: refused });
        deps.note(`mr-state ${taskId}/${unitId} !${target.mrIid} ${end}: ${refused}`);
      } else report.written.push({ taskId, unitId, state: end });
    }
    return report;
  }

  return {
    /** Один обход; идущий обход не дублируется — второй вызов ждёт его же. */
    sweep(): Promise<MrSweepReport> {
      running ??= sweep().finally(() => {
        running = undefined;
      });
      return running;
    },
    /** Дождаться идущего обхода (остановка проводки). */
    async idle(): Promise<void> {
      await running?.catch(() => undefined);
    },
  };
}

export type MrStateSweep = ReturnType<typeof createMrStateSweep>;
