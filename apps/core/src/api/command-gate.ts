import type { CommandEnvelope } from '@agentdeck/contracts/core/commands';
import { knownOutcome, type CommandResult } from '../conductor/commands.ts';
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
