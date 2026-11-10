import {
  SESSION_MACHINE,
  TASK_MACHINE,
  nextState,
  taskEndedOutcome,
} from '@agentdeck/contracts/core/states';
import type { EstimateBody } from '@agentdeck/contracts/core/estimate';
import type { LiveTask } from '../../journal/resume.ts';
import type { TaskFoldState } from '../../journal/reduce/reduce.types.ts';
import { CHAT_PRESET, estimateTask, type SplitEnv } from '../estimate/index.ts';
import type { TaskRegistry } from '../tasks.ts';
import { takeoverTargetOf } from './target.ts';
import type { TakeoverRefusal } from './takeover.types.ts';

/**
 * Чат перехвата (P161, D9): `chat@1` на месте в копии перехваченной единицы. Грант — на эту копию и
 * только `edit` (судья права `policy/permit` не пускает правку вне корня сеанса, а корень — копия),
 * и живёт он ровно столько, сколько чат: возврат кончает чат, грант уходит вместе с его задачей.
 * Ключ оценки чата — `cmdId` команды `take-over`: повтор после краха находит тот же чат
 * (`taskOfOrigin`), второго не открывает.
 */

const terminalSession = (state: string): boolean =>
  (SESSION_MACHINE.terminal as readonly string[]).includes(state);

/** Первое слово чата: модель знает, чья это копия, и не трогает её без просьбы человека. */
export function takeoverRequestOf(title: string, unitId: string, copy: string): string {
  return [
    `Человек взял единицу ${unitId} задачи «${title}» вручную и работает в её копии: ${copy}.`,
    'Конвейер задачи стоит, пока он не вернёт её ядру. Дождись его указаний и без его просьбы ничего не меняй.',
  ].join('\n');
}

export async function openTakeoverChat(
  task: LiveTask,
  cmdId: string,
  registry: TaskRegistry,
  env: SplitEnv,
): Promise<{ ok: true; unitId: string; copy: string; chatTaskId: string } | TakeoverRefusal> {
  const target = takeoverTargetOf(task);
  if (!target)
    return { ok: false, code: 'no-copy', reason: 'no unit of this task has a live copy' };
  const title = task.state.created?.title ?? task.taskId;
  const lang = task.state.created?.lang;
  const body: EstimateBody = {
    cmdId,
    proof: {},
    fields: {
      title: `Вручную: ${title}`.slice(0, 300),
      request: takeoverRequestOf(title, target.unitId, target.copy),
      repos: [{ path: target.copy, baseRef: null }],
      scenario: { preset: CHAT_PRESET },
      launchPolicy: 'auto',
      ciWait: false,
      placement: { kind: 'in-place', grant: { project: target.copy, ops: ['edit'] } },
      ...(lang ? { lang } : {}),
    },
  };
  const out = await estimateTask(body, registry, env, {
    created: () => ({ takeoverOf: { taskId: task.taskId, unitId: target.unitId } }),
  });
  if (out.status === 422)
    return { ok: false, code: 'takeover-chat-refused', reason: out.problems.join('; ') };
  // Повтор ключа после краха между чатом и строкой перехвата: обход сирот мог уже кончить этот чат
  // (перехвата у источника не было). Мёртвый чат перехвату не годится — человек открыл бы пустой
  // разговор без гранта; отказ, новый `take-over` (новый ключ) откроет новый чат.
  const chatEnded = stateOf(registry, out.reply.taskId)?.ended ?? null;
  if (chatEnded !== null)
    return {
      ok: false,
      code: 'takeover-chat-ended',
      reason: `takeover chat ${out.reply.taskId} of this command already ended; send take-over again`,
    };
  return { ok: true, ...target, chatTaskId: out.reply.taskId };
}

function stateOf(registry: TaskRegistry, taskId: string): TaskFoldState | undefined {
  try {
    return registry.live(taskId)?.state ?? registry.view(taskId);
  } catch {
    return undefined;
  }
}

/** Чаты перехвата задачи `taskId`, ещё не кончившиеся (или с живым сеансом). */
export function takeoverChatsOf(registry: TaskRegistry, taskId: string): string[] {
  const out: string[] = [];
  for (const s of registry.list()) {
    const state = stateOf(registry, s.taskId);
    if (state?.created?.takeoverOf?.taskId !== taskId) continue;
    if (s.ended === null || openSessions(state) > 0) out.push(s.taskId);
  }
  return out;
}

const openSessions = (state: TaskFoldState): number =>
  Object.values(state.sessions).filter((s) => !terminalSession(s.state)).length;

/** Конец чата ядром: идущий — `finish` (разговор закончен, не провален), иначе — `cancel`. */
function endChat(task: LiveTask, cmdId: string): void {
  const from = task.state.task;
  if (task.state.ended !== null) return;
  const event = from === 'running' ? 'finish' : 'cancel';
  const step = nextState(TASK_MACHINE, from, event);
  if (!step.ok) return;
  const moved = task.append({
    kind: 'task.transition',
    actor: 'core',
    cmdId,
    data: { taskId: task.taskId, event, from, to: step.to },
  });
  const ended = taskEndedOutcome(step.to);
  if (ended)
    task.append({
      kind: 'task.ended',
      actor: 'core',
      cmdId,
      cause: moved.seq,
      data: { outcome: ended },
    });
}

export interface EndChatsOptions {
  /** Сколько ждать, пока исполнитель чата снимет его сеансы. */
  waitMs: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/**
 * Кончить чаты перехвата задачи и дождаться, пока их сеансы сняты (исполнитель чата видит конец и
 * закрывает задачу — `closeTask`). Сеанс не снялся за `waitMs` — отказ: возврат с живой рукой в
 * копии нарушил бы «одна рука в копии», задача остаётся на паузе, человек повторит возврат.
 */
export async function endTakeoverChats(
  registry: TaskRegistry,
  taskId: string,
  cmdId: string,
  opts: EndChatsOptions,
): Promise<{ ok: true; ended: string[] } | TakeoverRefusal> {
  const chats = takeoverChatsOf(registry, taskId);
  for (const chatId of chats) {
    // Уже кончился (ждём только снятия сеанса) — открывать его снова незачем.
    if (stateOf(registry, chatId)?.ended !== null) continue;
    const live = registry.live(chatId);
    const opened = live ? { task: live } : await registry.open(chatId);
    if ('refused' in opened)
      return { ok: false, code: 'chat-unavailable', reason: `chat ${chatId}: ${opened.refused}` };
    endChat(opened.task, cmdId);
  }
  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const now = opts.now ?? Date.now;
  const until = now() + opts.waitMs;
  for (;;) {
    const open = chats.filter((id) => {
      const state = stateOf(registry, id);
      return state !== undefined && openSessions(state) > 0;
    });
    if (open.length === 0) return { ok: true, ended: chats };
    if (now() >= until)
      return {
        ok: false,
        code: 'chat-still-running',
        reason: `takeover chat session still running in ${open.join(', ')}`,
      };
    await sleep(200);
  }
}
