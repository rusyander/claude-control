import type { TaskView } from '@agentdeck/contracts/core/task-view';
import type { LaunchCommand } from './launch.types';
import { AFTER_LAUNCH, ENDED } from './launchFold';

/**
 * Запуск группы (этап 11, W3-18): человек выбрал «Группой — задача на пункт» и нажал «Запустить»
 * — он ждёт, что пойдут ВСЕ задачи группы, а не задача 0 с остальными за утверждением в ленте
 * каждой. Отдельного запуска группы у ядра нет, поэтому та же команда, что у одиночной задачи
 * (`approve-split` / `launch`), уходит каждой задаче по очереди. Повтор безопасен: уже запущенную
 * задачу видно по её виду — ей ничего не шлётся; команда без известного исхода (сеть) уходит
 * повторно тем же `cmdId` — ядро отдаёт сохранённый исход, второго запуска нет (P47). Отказ одной
 * задачи называется строкой, остальные всё равно запускаются.
 */

/** Почему задачу группы сейчас не запустить — по её виду, до команды. */
export type GroupNotReady =
  'no-view' | 'ended' | 'awaiting-split' | 'split-refused' | 'not-awaiting-launch';

export type GroupStep =
  | { kind: 'started' }
  | { kind: 'command'; command: LaunchCommand }
  | { kind: 'not-ready'; why: GroupNotReady };

export type GroupLaunchRow =
  | { taskId: string; status: 'started' }
  | { taskId: string; status: 'refused'; why: GroupNotReady | null; reason: string };

type GroupView = Pick<TaskView, 'state' | 'split'>;

/**
 * Что делать с задачей группы по её виду. Тот же порядок, что у причин одиночного запуска
 * (`launchBlockers`): кончившаяся — не запустить; уже идёт — пропустить; деление предложено —
 * утвердить (ядро утвердит и запустит); утверждено, а запуск упал — `launch` без второго
 * утверждения.
 */
export function groupStepOf(view: GroupView | null): GroupStep {
  if (!view) return { kind: 'not-ready', why: 'no-view' };
  if (ENDED.has(view.state)) return { kind: 'not-ready', why: 'ended' };
  if (AFTER_LAUNCH.has(view.state)) return { kind: 'started' };
  const split = view.split;
  // Предложено, но проверка ещё не решила — как `awaiting-split` у одиночной задачи.
  if (!split || split.state === 'proposed') return { kind: 'not-ready', why: 'awaiting-split' };
  if (split.state === 'refused') return { kind: 'not-ready', why: 'split-refused' };
  if (view.state !== 'awaiting-launch') return { kind: 'not-ready', why: 'not-awaiting-launch' };
  if (split.state === 'approved')
    return { kind: 'command', command: { kind: 'launch', fields: {} } };
  return {
    kind: 'command',
    command: { kind: 'approve-split', fields: { splitId: split.splitId } },
  };
}

/** Исход одной команды: применена, или отказ с причиной; `keep` — исход неизвестен, ключ держим. */
export type GroupSendResult = { ok: true } | { ok: false; reason: string; keep: boolean };

export interface GroupLaunchDeps {
  view: (taskId: string) => Promise<GroupView | null>;
  send: (taskId: string, command: LaunchCommand, cmdId: string) => Promise<GroupSendResult>;
  newId: () => string;
}

/** Ключ команды задачи: та же задача, вид и деление — тот же `cmdId`, пока исход неизвестен. */
const commandKey = (taskId: string, command: LaunchCommand): string =>
  `${taskId}|${command.kind}|${command.kind === 'approve-split' ? command.fields.splitId : ''}`;

/**
 * Каждая задача группы — своя попытка: чтение вида или команда упали — строка отказа этой
 * задачи, следующая всё равно идёт. `cmdIds` живёт у вызывающего между нажатиями: отказ ядра
 * ключ снимает (исправленное уйдёт новой командой, а не вернёт тот же отказ), неизвестный
 * исход — держит.
 */
export async function launchGroup(
  taskIds: readonly string[],
  deps: GroupLaunchDeps,
  cmdIds: Map<string, string>,
): Promise<GroupLaunchRow[]> {
  const rows: GroupLaunchRow[] = [];
  for (const taskId of taskIds) {
    let view: GroupView | null;
    try {
      view = await deps.view(taskId);
    } catch (error) {
      rows.push({ taskId, status: 'refused', why: null, reason: messageOf(error) });
      continue;
    }
    const step = groupStepOf(view);
    if (step.kind === 'started') {
      rows.push({ taskId, status: 'started' });
      continue;
    }
    if (step.kind === 'not-ready') {
      rows.push({ taskId, status: 'refused', why: step.why, reason: '' });
      continue;
    }
    const key = commandKey(taskId, step.command);
    const cmdId = cmdIds.get(key) ?? deps.newId();
    cmdIds.set(key, cmdId);
    const sent = await deps
      .send(taskId, step.command, cmdId)
      .catch((error: unknown): GroupSendResult => ({
        ok: false,
        reason: messageOf(error),
        keep: true,
      }));
    if (sent.ok) {
      rows.push({ taskId, status: 'started' });
      continue;
    }
    if (!sent.keep) cmdIds.delete(key);
    rows.push({ taskId, status: 'refused', why: null, reason: sent.reason });
  }
  return rows;
}

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
