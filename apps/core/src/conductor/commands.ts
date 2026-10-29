import type {
  CommandEnvelope,
  CommandKind,
  CommandOutcome,
} from '@agentdeck/contracts/core/commands';
import {
  TASK_MACHINE,
  nextState,
  taskEndedOutcome,
  type TaskEvent,
} from '@agentdeck/contracts/core/states';
import { commandBodyHash, maskedCommandBodyHash } from '../journal/command-body.ts';
import type { MaskFn } from '../journal/journal.types.ts';
import type { LiveTask } from '../journal/resume.ts';
import type { TaskFoldState } from '../journal/reduce/reduce.types.ts';
import { decideAuthority, type CommandProof } from '../policy/authority/authority.ts';
import { releaseResource } from './services.ts';

/**
 * Приём команды человека (01 §Commands, F23 F26). Порядок — часть свойства:
 *   1. повтор `cmdId` → сохранённый исход, второго действия нет (P47); доказательство при
 *      повторе не собирается — одноразовое число не сгорает на повторной отправке; тот же
 *      `cmdId` с ДРУГИМ телом — отказ `cmd-id-reused` (ревью M1);
 *   2. `command.received` с fsync ДО ответа (что бы ни было дальше, приём записан);
 *   3. полномочия (06 §Authority, P97) — отказ записан `command.rejected`;
 *   4. устаревший `expectSeq` → 409 + текущее состояние (сверка с `seq` до приёма);
 *   5. применение → `command.applied` или `command.rejected`.
 */

export type CommandResult = CommandOutcome & { state?: TaskFoldState };

/** Что команда делает с машиной задачи в фазе 2; остальные виды — свои части в своих фазах. */
const TASK_EVENTS: Partial<Record<CommandKind, TaskEvent>> = {
  launch: 'launch',
  pause: 'pause',
  resume: 'resume',
  cancel: 'cancel',
};

const PHASE_OF: Partial<Record<CommandKind, number>> = {
  'set-model': 4,
  'set-cli': 4,
  'set-route': 5,
  'edit-scenario': 4,
  answer: 4,
  'approve-split': 4,
  'edit-split': 4,
  'fresh-rerun': 5,
  'publish-now': 6,
  'move-build': 8,
  'message-to-step': 4,
  grant: 4,
  'clean-remote': 6,
};

function stored(state: TaskFoldState, cmdId: string): CommandResult | undefined {
  const record = state.commands[cmdId];
  if (!record || record.status === 'received' || record.outcomeSeq === undefined) return undefined;
  return {
    cmdId,
    status: record.status,
    seq: record.outcomeSeq,
    ...(record.code ? { code: record.code } : {}),
    ...(record.reason !== undefined ? { reason: record.reason } : {}),
    ...(record.outcome !== undefined ? { outcome: record.outcome } : {}),
  };
}

function reject(task: LiveTask, cmdId: string, code: string, reason: string): CommandResult {
  const line = task.append({
    kind: 'command.rejected',
    actor: 'core',
    cmdId,
    data: { code, reason },
  });
  return { cmdId, status: 'rejected', code, reason, seq: line.seq };
}

/**
 * Команды одной задачи идут по одной. Сбор доказательства асинхронный (таблица TCP читается
 * сотни миллисекунд): без очереди два одинаковых `cmdId`, пришедшие разом, оба не находили
 * исхода и оба писали `command.received` — второе действие (P47, замер теста).
 */
const queues = new WeakMap<LiveTask, Promise<unknown>>();
/** Команды, принятые по HTTP и ещё не получившие ответа (ждут очереди или доказательства). */
let inFlight = 0;

/** Глубина очереди команд этого ядра — для `/v1/health` (07). */
export function commandsInFlight(): number {
  return inFlight;
}

export function processCommand(
  task: LiveTask,
  command: CommandEnvelope,
  gatherProof: () => Promise<CommandProof>,
): Promise<CommandResult> {
  const previous = queues.get(task) ?? Promise.resolve();
  inFlight += 1;
  const run = previous
    .then(
      () => processOne(task, command, gatherProof),
      () => processOne(task, command, gatherProof),
    )
    .finally(() => {
      inFlight -= 1;
    });
  queues.set(
    task,
    run.catch(() => undefined),
  );
  return run;
}

/**
 * Что о `cmdId` уже известно по свёртке, без записи и без доказательства: сохранённый исход
 * повтора или отказ «тот же `cmdId`, другое тело». `undefined` — команду надо судить. Тот же
 * ответ для живой задачи и для закрытой (API отвечает, не открывая её — ревью F-47).
 */
export function knownOutcome(
  state: TaskFoldState,
  command: CommandEnvelope,
  mask?: MaskFn,
): CommandResult | undefined {
  const { cmdId } = command;
  const known = state.commands[cmdId];
  const body = { ...command, expectSeq: command.expectSeq ?? null };
  // Тело легло в журнал под маской DLP: сравнивать с отпечатком можно только через ту же маску
  // (ревью F-25 — тот же повтор с секретом отвергался `cmd-id-reused`).
  const sameBody =
    known !== undefined &&
    (known.bodyHash === commandBodyHash(body) ||
      (mask !== undefined && known.bodyHash === maskedCommandBodyHash(body, mask)));
  // Маски под рукой нет (суд до открытия задачи), а тело было маскировано: «другое тело» не
  // доказано — решит живая задача, у которой маска есть.
  if (known && !sameBody && known.masked && !mask) return undefined;
  if (known && !sameBody) {
    // Другое тело не исполняется и ничего не закрывает: ни исход (второго у `cmdId` не бывает),
    // ни принятую до краха команду — её законный повтор решится по её доказательству. Закрытие
    // отказом давало любому звонящему (и сессии) сорвать команду человека (ревью F-47, V3).
    const reason = `cmdId ${cmdId} already carries a different ${known.kind} command`;
    return { cmdId, status: 'rejected', code: 'cmd-id-reused', reason, seq: state.seq };
  }
  return stored(state, cmdId);
}

/**
 * `release-resource {rid}` (G25, P90): снятие с чтением назад; исход команды — факт чтения
 * (`verified` или `leak` с причиной), не «снято» на слово. Нет такого ресурса, уже снят или вид
 * снимается своей дорогой — отказ с кодом.
 */
async function applyRelease(task: LiveTask, command: CommandEnvelope): Promise<CommandResult> {
  const { rid } = command.fields as { rid: string };
  const got = await releaseResource(task, rid);
  if ('rejected' in got) return reject(task, command.cmdId, got.rejected, got.reason);
  const outcome: Record<string, string> =
    'verified' in got ? { rid, verified: got.verified } : { rid, leak: got.leak };
  const applied = task.append({
    kind: 'command.applied',
    actor: 'core',
    cmdId: command.cmdId,
    data: { outcome },
  });
  return { cmdId: command.cmdId, status: 'applied', seq: applied.seq, outcome };
}

async function processOne(
  task: LiveTask,
  command: CommandEnvelope,
  gatherProof: () => Promise<CommandProof>,
): Promise<CommandResult> {
  const { cmdId } = command;
  const known = knownOutcome(task.state, command, task.mask);
  if (known) return known;

  let seqBefore = task.state.seq;
  let proof: CommandProof;
  const pending = task.state.commands[cmdId];
  if (pending) {
    // Принят, но исхода нет (ядро умерло между приёмом и решением): доказательство уже в
    // журнале, решаем по нему; второй `command.received` не пишется.
    proof = pending.proof;
    seqBefore = pending.receivedSeq - 1;
  } else {
    proof = await gatherProof();
    task.append({
      kind: 'command.received',
      actor: proof.signature === 'valid' ? 'human:device' : 'human:panel',
      cmdId,
      data: {
        kind: command.kind,
        target: command.target,
        expectSeq: command.expectSeq ?? null,
        fields: command.fields,
        proof,
      },
    });
  }

  const authority = decideAuthority(command.kind, proof);
  if (!authority.allow) {
    if (authority.signal) {
      task.append({
        kind: 'signal',
        actor: 'core',
        cmdId,
        data: {
          signal: authority.signal,
          severity: 'stop',
          subject: command.kind,
          detail: authority.reason,
        },
      });
    }
    return reject(task, cmdId, authority.code, authority.reason);
  }

  if (command.expectSeq !== undefined && command.expectSeq !== seqBefore) {
    const result = reject(
      task,
      cmdId,
      'stale-seq',
      `expectSeq ${command.expectSeq}, task at ${seqBefore}`,
    );
    return { ...result, state: task.state };
  }

  if (command.kind === 'release-resource') return applyRelease(task, command);
  const event = TASK_EVENTS[command.kind];
  if (!event) {
    const phase = PHASE_OF[command.kind] ?? 0;
    return reject(task, cmdId, 'not-implemented', `${command.kind} applies from phase ${phase}`);
  }
  const from = task.state.task;
  const step = nextState(TASK_MACHINE, from, event);
  if (!step.ok) {
    const result = reject(task, cmdId, 'state-conflict', `${command.kind} not allowed in ${from}`);
    return { ...result, state: task.state };
  }
  const moved = task.append({
    kind: 'task.transition',
    actor: 'core',
    cmdId,
    data: { taskId: task.taskId, event, from, to: step.to },
  });
  // Конец машины задачи — всегда `task.ended` (P17): исход берётся из таблицы, а не из списка здесь.
  const ended = taskEndedOutcome(step.to);
  if (ended) {
    task.append({
      kind: 'task.ended',
      actor: 'core',
      cmdId,
      cause: moved.seq,
      data: { outcome: ended },
    });
  }
  const outcome = { from, to: step.to };
  const applied = task.append({ kind: 'command.applied', actor: 'core', cmdId, data: { outcome } });
  return { cmdId, status: 'applied', seq: applied.seq, outcome };
}
