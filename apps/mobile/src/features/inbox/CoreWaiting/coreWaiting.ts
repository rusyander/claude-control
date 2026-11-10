import type { TaskListItem } from '@agentdeck/contracts/core/panel-api';
import type { AskView, ScenarioView } from '@agentdeck/contracts/core/task-view';
import { askWaits, taskWaits } from '@agentdeck/contracts/core/waiting';
import type { CoreWaitingCard } from './coreWaiting.types';

/**
 * «Ждёт вас» на телефоне (этап 12, P153/P176): задача ядра попадает во «Вопросы», только если её
 * держит БЛОКИРУЮЩИЙ вопрос — открытый и без действия по умолчанию. Суд — та же функция, что у
 * доски панели и пересылки push (`contracts/core/waiting`): неблокирующий вопрос (ядро идёт
 * дальше с умолчанием), отвеченный и вид до этапа 12 сюда не попадают — телефон не зовёт туда,
 * где работа не стоит.
 */

/** Вид задачи, которого хватает суду: вопросы и сценарий (чат отличают по нему). */
export type WaitingTaskView = {
  asks: readonly AskView[];
  scenario?: Pick<ScenarioView, 'ref'> | null;
};

/** Сценарий чата ядра (`placement.ts` CHAT_PRESET): разговор, а не задача «Ждёт вас». */
const CHAT_SCENARIO = 'chat';

/**
 * Чат — не задача «Ждёт вас» (P152, тот же отбор, что `isChatTask` у доски ядра): его вопрос права
 * телефон уже показывает карточкой чата выше (`chat-inbox` несёт `core`), второй раз он задвоил бы
 * и раздел, и значок вкладки.
 */
const isChatView = (view: WaitingTaskView): boolean => view.scenario?.ref.id === CHAT_SCENARIO;

/** Чьи виды читать: только идущие задачи — у завершённой ждать нечего. */
export function liveTaskIds(tasks: readonly TaskListItem[]): string[] {
  return tasks.filter((task) => task.live && task.ended === null).map((task) => task.taskId);
}

export function coreWaitingCards(
  tasks: readonly TaskListItem[],
  views: ReadonlyMap<string, WaitingTaskView>,
): CoreWaitingCard[] {
  const live = new Set(liveTaskIds(tasks));
  return tasks.flatMap((task) => {
    const view = views.get(task.taskId);
    if (!live.has(task.taskId) || !view || isChatView(view) || !taskWaits(view.asks)) return [];
    const blocking = view.asks.filter(askWaits);
    return [
      {
        taskId: task.taskId,
        title: task.title?.trim() || null,
        count: blocking.length,
        question: blocking.find((ask) => ask.question?.trim())?.question?.trim() ?? '',
      },
    ];
  });
}
