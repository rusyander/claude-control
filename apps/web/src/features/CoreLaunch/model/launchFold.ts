import type { EstimateReply } from '@agentdeck/contracts/core/estimate';
import type { JournalDataV1 } from '@agentdeck/contracts/core/journal';
import type { TaskState } from '@agentdeck/contracts/core/states';
import type { GrantConfirmation } from '@agentdeck/contracts/core/user-layer';
import type { SseEvent } from '@entities/CoreTask';
import type {
  GrantGiven,
  GrantRow,
  LaunchBlocker,
  LaunchCommand,
  LaunchFold,
} from './launch.types';

/**
 * Экран запуска поверх потока задачи (F3): предложение деления, решение по нему, выданные гранты
 * и состояние задачи — свёрткой строк журнала из SSE. Предложения деления в виде задачи нет: его
 * единицы живут только в строке `split.proposed`, поэтому их читает лента, а не опрос.
 */

export const EMPTY_FOLD: LaunchFold = {
  split: null,
  grantsGiven: [],
  state: null,
  repoKeys: [],
  lastSeq: -1,
};

interface Line {
  seq: number;
  kind: string;
  data: unknown;
}

/** Строка журнала из кадра SSE; кадр не JSON или без номера — `null`, свёртка его пропускает. */
export function lineOfEvent(event: SseEvent): Line | null {
  try {
    const line = JSON.parse(event.data) as Partial<Line>;
    if (typeof line.seq !== 'number' || typeof line.kind !== 'string') return null;
    return { seq: line.seq, kind: line.kind, data: line.data };
  } catch {
    return null;
  }
}

/**
 * Одна строка в свёртку. Строка с номером не дальше уже свёрнутого — повтор после обрыва потока
 * (сервер шлёт с `Last-Event-ID`, но перечитка с начала тоже бывает): её пропускаем, иначе грант
 * или предложение задвоились бы.
 */
export function foldLaunchLine(fold: LaunchFold, line: Line | null): LaunchFold {
  if (!line || line.seq <= fold.lastSeq) return fold;
  const next: LaunchFold = { ...fold, lastSeq: line.seq };
  switch (line.kind) {
    case 'task.created': {
      const data = line.data as JournalDataV1['task.created'];
      return { ...next, repoKeys: data.repos.map((r) => r.repoKey), state: 'draft' };
    }
    case 'task.transition': {
      const data = line.data as JournalDataV1['task.transition'];
      return { ...next, state: data.to as TaskState };
    }
    case 'split.proposed': {
      const data = line.data as JournalDataV1['split.proposed'];
      return {
        ...next,
        split: {
          splitId: data.splitId,
          by: data.by,
          units: data.units,
          decided: null,
          seq: line.seq,
        },
      };
    }
    case 'split.decided': {
      const data = line.data as JournalDataV1['split.decided'];
      if (!next.split || next.split.splitId !== data.splitId) return next;
      return { ...next, split: { ...next.split, decided: data.outcome } };
    }
    case 'grant.given': {
      const data = line.data as JournalDataV1['grant.given'];
      const given: GrantGiven = { project: data.project, globs: data.globs, ops: data.ops };
      return { ...next, grantsGiven: [...next.grantsGiven, given] };
    }
    default:
      return next;
  }
}

/** Ключ строки гранта на экране: репозиторий, маски и операции — одна запись `grantRequired`. */
export function grantKey(g: GrantConfirmation): string {
  return `${g.repoKey}|${[...g.globs].sort().join(',')}|${[...g.ops].sort().join(',')}`;
}

/** Ключ, скрытый маской DLP («••••••»): какой это репозиторий, человек не видит. */
const MASKED = /^[•*]+$/u;

/**
 * Подтверждён ли грант журналом: выдан грант на тот же репозиторий, покрывающий каждую маску и
 * каждую операцию строки. Истина — строка `grant.given`, а не нажатая кнопка: потерянный ответ
 * команды не делает грант ни выданным, ни невыданным.
 */
export function grantRows(
  grants: readonly GrantConfirmation[],
  given: readonly GrantGiven[],
): GrantRow[] {
  return grants.map((grant) => {
    if (MASKED.test(grant.repoKey)) return { key: grantKey(grant), grant, status: 'unreadable' };
    const confirmed = given.some(
      (g) =>
        g.project === grant.repoKey &&
        grant.globs.every((glob) => g.globs.includes(glob)) &&
        grant.ops.every((op) => g.ops.includes(op)),
    );
    return { key: grantKey(grant), grant, status: confirmed ? 'confirmed' : 'pending' };
  });
}

export const AFTER_LAUNCH = new Set<TaskState>([
  'running',
  'paused',
  'waiting-window',
  'publishing',
  'done',
]);
export const ENDED = new Set<TaskState>(['cancelled', 'failed']);

export interface LaunchGateInput {
  reply: Pick<EstimateReply, 'state' | 'grants'>;
  fold: LaunchFold;
  /** Состояние из вида задачи (свежее свёртки потока, пока поток догоняет). */
  viewState: TaskState | null;
  splitDirty: boolean;
}

/**
 * Почему запуск нельзя нажать. Пусто — можно. Порядок — от самого крупного: отказанная задача
 * не ждёт ни деления, ни грантов. Гранты блокируют запуск до подтверждения ВСЕХ строк (06:110):
 * иначе грант спрашивался бы посреди шага, на первом отказе судьи права.
 */
export function launchBlockers(input: LaunchGateInput): LaunchBlocker[] {
  const state = input.viewState ?? input.fold.state;
  if (input.reply.state === 'refused' || (state !== null && ENDED.has(state))) return ['refused'];
  if (state !== null && AFTER_LAUNCH.has(state)) return ['launched'];
  const out: LaunchBlocker[] = [];
  const split = input.fold.split;
  if (!split || split.decided === null) out.push('awaiting-split');
  else if (split.decided === 'refused') out.push('split-refused');
  else if (state !== 'awaiting-launch') out.push('not-awaiting-launch');
  if (input.splitDirty) out.push('split-unsaved');
  const rows = grantRows(input.reply.grants, input.fold.grantsGiven);
  if (rows.some((r) => r.status === 'unreadable')) out.push('grant-unreadable');
  if (rows.some((r) => r.status === 'pending')) out.push('grants-unconfirmed');
  return out;
}

/**
 * Какая команда запускает: деление ещё не утверждено человеком — `approve-split` (ядро утвердит и
 * запустит с предпроверкой); уже утверждено, а запуск упал на дороге — `launch` (второе
 * утверждение не нужно).
 */
export function launchCommand(fold: LaunchFold): LaunchCommand | null {
  const split = fold.split;
  if (!split || split.decided === null || split.decided === 'refused') return null;
  if (split.decided === 'approved') return { kind: 'launch', fields: {} };
  return { kind: 'approve-split', fields: { splitId: split.splitId } };
}
