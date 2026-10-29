import type { ActionKind } from '@agentdeck/contracts/core/journal';
import { newId } from '../lib/ids/uuidv7.ts';
import type { LiveTask } from '../journal/resume.ts';

/**
 * Внешние действия переживают крах (01 §Outbox, R:S1-10, P86): `action.started` уходит на диск
 * с fsync ДО действия; потом действие; потом `action.done {result}` или `action.failed {code}`.
 * Начатое и не законченное к загрузке разбирает `reconcile.ts` по факту, не повтором вслепую.
 */

export interface ActionSpec {
  kind: ActionKind;
  target: string;
  /** Чем сверка узнает, что действие уже было (sha, ветка + время, хеш тела, метка). */
  idempotencyHint: string;
}

export type JsonValue = string | number | boolean | null | JsonValue[] | { [k: string]: JsonValue };

export class ActionFailed extends Error {
  readonly code: string;
  constructor(code: string, detail: string) {
    super(detail);
    this.name = 'ActionFailed';
    this.code = code;
  }
}

/**
 * Эффект выполнен, а `action.done` не записан: действие не повторять — оно `started` в журнале,
 * его исход по факту назовёт сверка (`reconcile.ts`).
 */
export class ActionUnjournaled extends Error {
  readonly actionId: string;
  constructor(actionId: string, cause: unknown) {
    super(
      `action ${actionId} ran but action.done was not journaled: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
      { cause },
    );
    this.name = 'ActionUnjournaled';
    this.actionId = actionId;
  }
}

export async function runAction(
  task: LiveTask,
  spec: ActionSpec,
  effect: (actionId: string) => Promise<JsonValue>,
  scope: { unitId?: string; stepId?: string; cause?: number } = {},
): Promise<
  { actionId: string; ok: true; result: JsonValue } | { actionId: string; ok: false; code: string }
> {
  const actionId = newId();
  // `action.*` — не телеметрия: запись возвращается только после fsync (writer).
  const started = task.append({
    kind: 'action.started',
    actor: 'core',
    data: { actionId, ...spec },
    ...scope,
  });
  let result: JsonValue;
  try {
    result = await effect(actionId);
  } catch (error) {
    const code = error instanceof ActionFailed ? error.code : 'effect-threw';
    const detail = error instanceof Error ? error.message : String(error);
    task.append({
      kind: 'action.failed',
      actor: 'core',
      data: { actionId, code, detail },
      cause: started.seq,
      ...(scope.unitId ? { unitId: scope.unitId } : {}),
      ...(scope.stepId ? { stepId: scope.stepId } : {}),
    });
    return { actionId, ok: false, code };
  }
  try {
    task.append({
      kind: 'action.done',
      actor: 'core',
      data: { actionId, result },
      cause: started.seq,
      ...(scope.unitId ? { unitId: scope.unitId } : {}),
      ...(scope.stepId ? { stepId: scope.stepId } : {}),
    });
  } catch (error) {
    // Эффект УЖЕ случился, записи об этом нет (ревью F-27): `action.failed` сказал бы «можно
    // повторить» — второй пуш/MR. Действие остаётся `started`, исход решит сверка по факту.
    throw new ActionUnjournaled(actionId, error);
  }
  return { actionId, ok: true, result };
}

/** Начатые и не законченные действия — вход сверки при загрузке. */
export function openActions(task: LiveTask): {
  actionId: string;
  kind: ActionKind;
  target: string;
  idempotencyHint: string;
  startedAt: number;
  startedSeq: number;
}[] {
  return Object.entries(task.state.actions)
    .filter(([, action]) => action.status === 'started')
    .map(([actionId, action]) => ({
      actionId,
      kind: action.kind,
      target: action.target,
      idempotencyHint: action.idempotencyHint,
      startedAt: action.startedAt,
      startedSeq: action.startedSeq,
    }));
}
