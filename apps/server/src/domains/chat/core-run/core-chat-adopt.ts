import type { TaskView } from '@agentdeck/contracts/core/task-view';
import { isSandboxPath } from '../ChatArtifacts/ChatArtifacts.ts';
import { layoutForCwd } from '../../project-git/copy-readiness.ts';
import { coreChatCwdOf, coreChatOfTask, createCoreChatBook } from './core-chat-book.ts';
import type { CoreChatPort } from './core-run.types.ts';

/**
 * Усыновление разговора чата перехвата (этап 12, B5): «Взять вручную» открывает чат ядром, а не
 * панелью, и книга чата его разговора не знает — ссылка «Открыть чат» (`/core/chat?id=<задача>`)
 * вела в пустой `/chat`. Здесь книга получает запись того же вида, что пишет сама панель для своего
 * чата (`core-run.ts`): id разговора — первый сеанс шага `chat` (Claude получает его как
 * `--session-id`), CLI — CLI сеанса, папка — копия единицы из перехвата задачи-источника.
 *
 * Усыновляется только настоящий чат перехвата: вид задачи несёт `takeoverOf`, и задача-источник
 * сейчас держит открытый перехват ИМЕННО с этим чатом. Чужая задача ядра, закрытый перехват или
 * чат, ещё не открывший сеанс, — `undefined`: ссылка ведёт в пустой чат, как прежде, без записи.
 */

/** Первый сеанс последнего шага `chat` — с него начинается разговор (как `sessionAfter` прогона). */
function firstChatSession(
  view: TaskView,
): { stepId: string; sessionId: string; cli: string } | null {
  const step = view.steps
    .filter((s) => s.stepKind === 'chat')
    .sort((a, b) => b.startedSeq - a.startedSeq)[0];
  if (!step) return null;
  const first = view.sessions
    .filter((s) => s.stepId === step.stepId)
    .sort((a, b) => a.startedSeq - b.startedSeq)[0];
  return first ? { stepId: step.stepId, sessionId: first.sessionId, cli: first.cli } : null;
}

export async function adoptTakeoverChat(
  port: Pick<CoreChatPort, 'view'>,
  bookFile: string,
  taskId: string,
): Promise<string | undefined> {
  const known = coreChatOfTask(bookFile, taskId);
  if (known) return known;
  const view = await port.view(taskId).catch(() => null);
  if (!view?.takeoverOf) return undefined;
  const source = await port.view(view.takeoverOf.taskId).catch(() => null);
  const takeover = source?.takeover;
  if (!takeover || takeover.chatTaskId !== taskId) return undefined;
  const first = firstChatSession(view);
  if (!first) return undefined;
  createCoreChatBook(bookFile).set(first.sessionId, {
    taskId,
    stepId: first.stepId,
    cli: first.cli,
    cwd: takeover.copy,
  });
  return first.sessionId;
}

/**
 * Вкладка проекта, в чьём списке стоит разговор книги: основная копия его папки (тем же правилом
 * сводка ставит `homeProjectPath`), иначе сама папка. Переход «Открыть чат» открывает её вместе с
 * разговором: чат перехвата живёт в копии единицы, и без своей вкладки домашний список (только
 * песочница) его не показывал — открыт, а в списке «Показано 0 из 0». Песочница и разговор без
 * папки — `undefined`: им вкладка не нужна.
 */
export function coreChatProjectOf(bookFile: string, chatId: string): string | undefined {
  const cwd = coreChatCwdOf(bookFile, chatId);
  if (!cwd || isSandboxPath(cwd)) return undefined;
  return layoutForCwd(cwd).mainDir ?? cwd;
}
