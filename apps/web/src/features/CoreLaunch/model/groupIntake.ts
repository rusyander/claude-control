import { classifyDedupe, INTAKE_ANSWERS, intakeDedupe } from '@agentdeck/contracts/core/intake';
import type { TaskView } from '@agentdeck/contracts/core/task-view';
import { AFTER_LAUNCH, ENDED } from './launchFold';

/**
 * Подтверждение карточек группы (этап 11, W3-18): у ведущего каждая задача группы спрашивает свою
 * карточку приёма, и запуск группы ждёт, пока человек подтвердит их все в ленте каждой задачи.
 * Одно нажатие шлёт КАЖДОЙ задаче с открытым вопросом карточки ту же команду, что карточка вопроса
 * в её ленте: `answer` с подписью «Подтвердить карточку». Ответ — команда человека (P23): ядро
 * пишет его в журнал задачи от `human:panel`; панель ничего не подтверждает сама. Повтор
 * безопасен: подтверждённую задачу видно по её виду — ей ничего не шлётся; ответ без известного
 * исхода (сеть) уходит повторно тем же `cmdId` — ядро отдаёт сохранённый исход (P47).
 */

/** Почему задаче группы сейчас нечего подтвердить с этой кнопки — по её виду, до команды. */
export type IntakeNotReady = 'no-view' | 'ended';

type IntakeView = Pick<TaskView, 'state' | 'asks'>;

export type IntakeStep =
  { kind: 'done' } | { kind: 'answer'; askId: string } | { kind: 'not-ready'; why: IntakeNotReady };

export type GroupIntakeRow =
  | { taskId: string; status: 'confirmed' | 'skipped' }
  | { taskId: string; status: 'refused'; why: IntakeNotReady | null; reason: string };

/**
 * Что делать с карточкой задачи по её виду. Вопрос карточки — только с ключом `intake:<taskId>`:
 * вопрос класса того же источника (`classify:<taskId>`, когда `classify` в `lead.alwaysAsk`) — не
 * этой кнопки, его подпись карточки ядро отвергло бы. Задача идёт, карточка принята сама или
 * вопрос ещё не задан — подтверждать нечего.
 */
export function intakeStepOf(taskId: string, view: IntakeView | null): IntakeStep {
  if (!view) return { kind: 'not-ready', why: 'no-view' };
  if (ENDED.has(view.state)) return { kind: 'not-ready', why: 'ended' };
  if (AFTER_LAUNCH.has(view.state)) return { kind: 'done' };
  const key = intakeDedupe(taskId);
  const open = view.asks.find((a) => a.dedupe === key && a.state === 'open');
  return open ? { kind: 'answer', askId: open.askId } : { kind: 'done' };
}

/**
 * Ждёт ли задача ответа о классе (`classify` в `lead.alwaysAsk`): открыт вопрос с ключом
 * `classify:<taskId>`, задача не кончилась и не запущена. Этот вопрос кнопка не отвечает — класс
 * выбирает человек в ленте задачи, экран запуска только называет, кого он держит.
 */
export function awaitsClassAnswer(taskId: string, view: IntakeView | null | undefined): boolean {
  if (!view || ENDED.has(view.state) || AFTER_LAUNCH.has(view.state)) return false;
  const key = classifyDedupe(taskId);
  return view.asks.some((a) => a.dedupe === key && a.state === 'open');
}

/** Задачи группы, ждущие ответа о классе, — с номером задачи в группе (с единицы), по порядку. */
export function classWaitingOf(
  views: readonly (readonly [string, IntakeView | null | undefined])[],
): { taskId: string; n: number }[] {
  return views.flatMap(([taskId, view], i) =>
    awaitsClassAnswer(taskId, view) ? [{ taskId, n: i + 1 }] : [],
  );
}

/** Сколько задач группы ждут подтверждения карточки — число на кнопке; `0` — кнопки нет. */
export function pendingIntakeCount(
  views: readonly (readonly [string, IntakeView | null | undefined])[],
): number {
  return views.filter(([id, v]) => v && intakeStepOf(id, v).kind === 'answer').length;
}

/** Исход одной команды: применена, или отказ с причиной; `keep` — исход неизвестен, ключ держим. */
export type IntakeSendResult = { ok: true } | { ok: false; reason: string; keep: boolean };

export interface GroupIntakeDeps {
  view: (taskId: string) => Promise<IntakeView | null>;
  send: (
    taskId: string,
    fields: { askId: string; answer: string },
    cmdId: string,
  ) => Promise<IntakeSendResult>;
  newId: () => string;
}

/**
 * Каждая задача группы — своя попытка: чтение вида или ответ упали — строка отказа этой задачи,
 * следующая всё равно идёт. `cmdIds` живёт у вызывающего между нажатиями (ключ — задача и вопрос):
 * отказ ядра ключ снимает, неизвестный исход — держит. `lang` — язык подписи ответа (ядро
 * принимает подпись любого языка).
 */
export async function confirmGroupIntake(
  taskIds: readonly string[],
  deps: GroupIntakeDeps,
  cmdIds: Map<string, string>,
  lang: keyof typeof INTAKE_ANSWERS = 'ru',
): Promise<GroupIntakeRow[]> {
  const rows: GroupIntakeRow[] = [];
  for (const taskId of taskIds) {
    let view: IntakeView | null;
    try {
      view = await deps.view(taskId);
    } catch (error) {
      rows.push({ taskId, status: 'refused', why: null, reason: messageOf(error) });
      continue;
    }
    const step = intakeStepOf(taskId, view);
    if (step.kind === 'done') {
      rows.push({ taskId, status: 'skipped' });
      continue;
    }
    if (step.kind === 'not-ready') {
      rows.push({ taskId, status: 'refused', why: step.why, reason: '' });
      continue;
    }
    const key = `${taskId}|${step.askId}`;
    const cmdId = cmdIds.get(key) ?? deps.newId();
    cmdIds.set(key, cmdId);
    const fields = { askId: step.askId, answer: INTAKE_ANSWERS[lang].confirm };
    const sent = await deps
      .send(taskId, fields, cmdId)
      .catch((error: unknown): IntakeSendResult => ({
        ok: false,
        reason: messageOf(error),
        keep: true,
      }));
    if (sent.ok) {
      rows.push({ taskId, status: 'confirmed' });
      continue;
    }
    if (!sent.keep) cmdIds.delete(key);
    rows.push({ taskId, status: 'refused', why: null, reason: sent.reason });
  }
  return rows;
}

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
