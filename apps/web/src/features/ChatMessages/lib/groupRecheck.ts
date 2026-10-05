import type { SplitPlanView } from '@agentdeck/contracts/chat-handoff';
import type { ChildStageGroup } from '../ui/ChildStages.types';

/**
 * «Перепроверить MR» в строке хаба (владелец 05.10.2026). Кнопку получает
 * доставленная группа с MR и живой копией: её разговор продолжит перепроверка.
 * Пока перепроверка идёт (звено работает или слово ждёт места) — строка
 * говорит «перепроверяется»; последняя кончилась доставкой — зелёная отметка
 * со временем. Убранная копия, отменённый план и чужой MR (ревью по ссылке не
 * доставляет) — кнопки нет: продолжать негде.
 */
export function recheckOf(
  group: SplitPlanView['groups'][number],
  split: SplitPlanView,
  isRunning: boolean,
): Pick<ChildStageGroup, 'recheck'> {
  if (split.cancelledAt || !group.deliver || !group.mr || !group.path || group.cleaned) return {};
  // Влитой MR перепроверять нечего — сервер откажет на каждое нажатие (ревью R4);
  // ревью по ссылке (Т7) смотрит чужой MR — тоже (ревью Q1, как `recheckable`).
  if (group.mrClosed === 'merged' || group.review || !group.chatId) return {};
  const pending = Boolean(group.recheckRequestedAt);
  // Идущее звено без запроса перепроверки — это другая работа (ответ ревьюеру,
  // продолжение): кнопки на время хода нет, как у «Принять».
  if (!pending && (group.status !== 'done' || isRunning)) return {};
  return {
    recheck: {
      parentChatId: split.parentChatId,
      index: group.index,
      ...(group.recheckRequestedAt ? { requestedAt: group.recheckRequestedAt } : {}),
      ...(group.recheckedAt ? { checkedAt: group.recheckedAt } : {}),
    },
  };
}
