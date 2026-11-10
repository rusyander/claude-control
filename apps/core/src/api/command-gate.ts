import type { CommandEnvelope } from '@agentdeck/contracts/core/commands';
import { knownOutcome, type CommandResult } from '../conductor/commands.ts';
import { replayEstimate } from '../conductor/estimate/index.ts';
import { reworkDone } from '../conductor/takeover/rework.ts';
import type { ReworkPort } from '../conductor/takeover/takeover.types.ts';
import type { TaskRegistry } from '../conductor/tasks.ts';
import type { TaskFoldState } from '../journal/reduce/reduce.types.ts';
import { decideAuthority, type CommandProof } from '../policy/authority/authority.ts';
import type { TokenClass } from './auth.ts';
import { apiError, type ApiError } from './errors.ts';

/**
 * Суд команды ДО открытия задачи (ревью F-47, verify-api V2): открыть задачу — взять аренду,
 * писать журнал, держать удары. Задачу, которую ядро не держит, открывает только команда, чьи
 * полномочия уже прошли: токен сессии и звонящий без доказательства не возобновляют ни чужую,
 * ни законченную задачу. Живая задача судится в дирижёре, как раньше — с записью отказа.
 */

export type PreOpenRefusal = { result: CommandResult } | { status: number; error: ApiError };

export async function refuseBeforeOpen(
  registry: TaskRegistry,
  command: CommandEnvelope,
  token: TokenClass,
  proof: () => Promise<CommandProof>,
  rework?: () => ReworkPort | undefined,
): Promise<PreOpenRefusal | undefined> {
  const { taskId } = command.target;
  if (registry.live(taskId)) return undefined;
  let view: TaskFoldState | undefined;
  try {
    view = registry.view(taskId);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { status: 500, error: apiError('journal-unreadable', reason) };
  }
  if (!view) return { status: 404, error: apiError('task-unavailable', 'no such task') };
  // Повтор решённой команды отвечает сохранённым исходом и по закрытой задаче — без открытия.
  // Маска — та же, что у писателя журнала: тело в журнале замаскировано (F-25).
  const known = knownOutcome(view, command, registry.mask);
  if (known) return { result: known };
  if (view.ended !== null) {
    // Этап 12 (P162): доработка законченной задачи — носитель ответов, а не строка источника.
    if (command.kind === 'rework' && rework)
      return reworkEnded(registry, command, token, proof, rework, view);
    // Законченную задачу команда не возобновляет: ни аренды, ни строк после `task.ended`.
    return { status: 409, error: apiError('task-ended', `task ended: ${view.ended}`) };
  }
  const refusal = (code: string, reason: string): PreOpenRefusal => ({
    result: { cmdId: command.cmdId, status: 'rejected', code, reason, seq: view.seq },
  });
  if (token === 'session') {
    return refusal('forged-authority', 'command from a session token');
  }
  // Принята до краха тем же телом: решится по доказательству из журнала, не по этому звонку.
  if (view.commands[command.cmdId]?.status === 'received') return undefined;
  const authority = decideAuthority(command.kind, await proof());
  if (authority.allow) return undefined;
  return refusal(authority.code, authority.reason);
}

/**
 * Доработка законченной задачи до открытия (P162): журнал источника не трогается (строк после
 * `task.ended` нет), повтор держит ключ оценки носителя — повтор того же `cmdId` отвечает той же
 * задачей ДО суда полномочий (одноразовое число первого звонка уже сгорело, как у
 * `replayEstimate`). Новый — суд полномочий, затем порт; отказ порта — его код и причина.
 */
async function reworkEnded(
  registry: TaskRegistry,
  command: CommandEnvelope,
  token: TokenClass,
  proof: () => Promise<CommandProof>,
  port: () => ReworkPort | undefined,
  view: TaskFoldState,
): Promise<PreOpenRefusal> {
  const { cmdId } = command;
  const result = (r: Omit<CommandResult, 'cmdId' | 'seq'>): PreOpenRefusal => ({
    result: { cmdId, seq: view.seq, ...r } as CommandResult,
  });
  const rejected = (code: string, reason: string) => result({ status: 'rejected', code, reason });
  const replayed = replayEstimate(registry, cmdId);
  if (replayed) return result({ status: 'applied', outcome: { carrierTaskId: replayed.taskId } });
  if (token === 'session') return rejected('forged-authority', 'command from a session token');
  const authority = decideAuthority(command.kind, await proof());
  if (!authority.allow) return rejected(authority.code, authority.reason);
  const { text } = command.fields as { text: string };
  const got = await reworkDone({ taskId: command.target.taskId, state: view }, cmdId, text, port());
  if (!got.ok) return rejected(got.code, got.reason);
  return result({ status: 'applied', outcome: { carrierTaskId: got.carrierTaskId } });
}
