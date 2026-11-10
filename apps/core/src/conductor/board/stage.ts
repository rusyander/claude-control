import type { BoardCard, BoardColumn, BoardEntry } from '@agentdeck/contracts/core/board';
import { askWaits, taskWaits } from '@agentdeck/contracts/core/waiting';
import { boardStopOf, openTakeoverOf } from '../../journal/reduce/fold-view.ts';
import type { StepRecord, TaskFoldState } from '../../journal/reduce/reduce.types.ts';
import { CHAT_PRESET } from '../estimate/placement.ts';
import { allowedMoves } from './moves.ts';

/**
 * Колонка карточки — чистая функция фактов журнала (этап 12, P152, P153): никто её не двигает,
 * её выводят. Запись до задачи стоит во «Входящих» или «Очереди»; задача — в колонке своей
 * САМОЙ ОТСТАЮЩЕЙ живой стадии (одна единица ещё в работе, другая на ревью — карточка «в работе»:
 * доска не обещает больше, чем сделано). Блокирующий вопрос — «Ждёт вас» поверх стадии,
 * неблокирующий — значок на карточке в её колонке. Конец: MR слит или закрыт у форжа, MR открыт
 * без конца — колонка MR, иначе «Закрыта». Чат (разговор с человеком и чат перехвата) — не карточка.
 */

/** Порядок стадий слева направо: отстающая — с меньшим номером. */
const STAGE_ORDER: Record<string, number> = {
  triage: 0,
  work: 1,
  review: 2,
  check: 3,
  ready: 4,
  mr: 5,
};

/** Вид шага сценария → стадия доски; вид без строки — «в работе». */
const STAGE_OF_KIND: Record<string, BoardColumn> = {
  intake: 'triage',
  plan: 'triage',
  research: 'triage',
  split: 'triage',
  work: 'work',
  fix: 'work',
  custom: 'work',
  'answer-reviewers': 'work',
  review: 'review',
  'review-cross': 'review',
  check: 'check',
  'final-gate': 'check',
  walk: 'check',
  publish: 'ready',
};

/** Шаг ещё идёт (или ждёт), а не кончился: только такие шаги держат стадию. */
const LIVE_STEP: ReadonlySet<StepRecord['state']> = new Set([
  'queued',
  'running',
  'checking',
  'waiting-human',
  'round-capped',
]);

const BEFORE_RUN: ReadonlySet<string> = new Set(['draft', 'estimating', 'awaiting-launch']);
const DONE_UNIT: ReadonlySet<string> = new Set(['published', 'done', 'closed']);

export function stageOfKind(kind: string): BoardColumn {
  return STAGE_OF_KIND[kind] ?? 'work';
}

/** Чат — не задача доски (P152): разговор с человеком и чат перехвата живут в своих экранах. */
export function isChatTask(state: TaskFoldState): boolean {
  return state.created?.scenario.id === CHAT_PRESET;
}

function slowest(columns: readonly BoardColumn[]): BoardColumn | null {
  let best: BoardColumn | null = null;
  for (const c of columns)
    if (best === null || (STAGE_ORDER[c] ?? 0) < (STAGE_ORDER[best] ?? 0)) best = c;
  return best;
}

function firstMr(state: TaskFoldState) {
  for (const p of Object.values(state.publication)) if (p.mr) return p;
  return null;
}

/** Колонка задачи по фактам её журнала. */
export function columnOfTask(state: TaskFoldState): BoardColumn {
  if (taskWaits(Object.values(state.asks))) return 'waiting';
  if (state.ended !== null) {
    const pub = firstMr(state);
    if (pub?.mrState) return pub.mrState.state === 'merged' ? 'merged' : 'closed';
    return pub ? 'mr' : 'closed';
  }
  if (BEFORE_RUN.has(state.task)) return 'triage';
  const live = Object.values(state.steps)
    .filter((s) => LIVE_STEP.has(s.state))
    .map((s) => stageOfKind(s.stepKind));
  const held = slowest(live);
  if (held) return held;
  if (firstMr(state)) return 'mr';
  const units = Object.values(state.units);
  if (state.task === 'publishing' || units.some((u) => u.state === 'ready-to-publish'))
    return 'ready';
  // Ни одного живого шага (между шагами, пауза): стадия последнего начатого.
  const last = Object.values(state.steps).sort((a, b) => b.startedSeq - a.startedSeq)[0];
  return last ? stageOfKind(last.stepKind) : 'triage';
}

/** Время из uuidv7: первые 48 бит — мс эпохи. */
export function uuidTime(id: string): number {
  return Number.parseInt(id.replace(/-/g, '').slice(0, 12), 16);
}

function unitsOf(state: TaskFoldState): BoardCard['units'] {
  const split = Object.values(state.units).filter((u) => u.splitId !== null);
  if (split.length === 0) return undefined;
  return { done: split.filter((u) => DONE_UNIT.has(u.state)).length, total: split.length };
}

function mrOf(state: TaskFoldState): BoardCard['mr'] {
  const pub = firstMr(state);
  if (!pub?.mr) return undefined;
  return {
    url: pub.mr.url,
    iid: pub.mr.mrIid,
    ...(pub.mr.title ? { title: pub.mr.title } : {}),
    state: pub.mrState?.state ?? 'opened',
  };
}

/** Карточка задачи; `entry` — запись доски, с которой задача стартовала (если есть). */
export function taskCard(state: TaskFoldState, entry?: BoardEntry): BoardCard {
  const created = state.created;
  const asks = Object.values(state.asks);
  const takeover = openTakeoverOf(state);
  const units = unitsOf(state);
  const mr = mrOf(state);
  return {
    kind: 'task',
    id: state.taskId,
    taskId: state.taskId,
    ...(entry ? { entryId: entry.entryId, source: entry.source, rank: entry.rank } : {}),
    column: columnOfTask(state),
    title: created?.title ?? state.taskId,
    state: state.task,
    stop: boardStopOf(state) ?? 'mr',
    ...(created?.scenario ? { preset: created.scenario.id } : {}),
    waiting: taskWaits(asks),
    questions: asks.filter((a) => a.state === 'open' && !askWaits(a)).length,
    ...(units ? { units } : {}),
    ...(created?.groupId ? { groupId: created.groupId } : {}),
    ...(created?.parentTaskId ? { parentTaskId: created.parentTaskId } : {}),
    ...(created?.launchOrigin ? { launchOrigin: created.launchOrigin } : {}),
    ...(created?.lead ? { lead: created.lead } : {}),
    ...(mr ? { mr } : {}),
    // Чат перехвата (`chatTaskId`) — по нему панель открывает разговор человека в копии.
    takeover: takeover
      ? {
          unitId: takeover.unitId,
          copy: takeover.copy,
          ...(takeover.chatTaskId ? { chatTaskId: takeover.chatTaskId } : {}),
        }
      : null,
    moves: [],
    createdAt: uuidTime(state.taskId),
    ...(entry?.startedAt === undefined ? {} : { startedAt: entry.startedAt }),
  };
}

/** Колонка записи без задачи; отклонённая — без карточки (`null`), она остаётся в `entries`. */
export function entryColumn(entry: BoardEntry): BoardColumn | null {
  switch (entry.state) {
    case 'inbox':
      return 'inbox';
    case 'queued':
    case 'starting':
      return 'queue';
    default:
      return null;
  }
}

export function entryCard(entry: BoardEntry): BoardCard | null {
  const column = entryColumn(entry);
  if (column === null) return null;
  return {
    kind: 'entry',
    id: entry.entryId,
    entryId: entry.entryId,
    column,
    title: entry.source.title,
    state: entry.state,
    stop: entry.stop,
    preset: entry.preset,
    source: entry.source,
    rank: entry.rank,
    waiting: false,
    questions: 0,
    takeover: null,
    ...(entry.reason ? { reason: entry.reason } : {}),
    moves: allowedMoves(entry),
    createdAt: entry.createdAt,
    ...(entry.startedAt === undefined ? {} : { startedAt: entry.startedAt }),
  };
}
