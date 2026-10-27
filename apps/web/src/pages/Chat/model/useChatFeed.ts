import type { AgentRun } from '@shared/lib/agent-runs';
import { isStreamShown, type StreamState } from '@shared/lib/chat-stream';
import { useChatAutoRefresh, useChatMessages, useChatProgress } from '@entities/Chat';
import { useAgentPane } from '@entities/AgentTree';
import { lastTurnFacts, useTurnToolHint } from '@entities/Platform';
import { withoutLiveTurn } from '../lib/liveTurn';
import { useMessagesLimit } from './useMessagesLimit';

export interface ChatFeedInput {
  /** Настоящий id открытого разговора (у черновика его ещё нет). */
  activeChatId: string | undefined;
  /** Потребитель маршрута контура: `groups` у звена разделения, иначе `chat`. */
  consumer: 'groups' | 'chat';
  run: AgentRun;
  stream: StreamState;
  isRunning: boolean;
}

/**
 * Что показывает лента открытого разговора: окно истории, сама история без
 * текущего хода, подсказка контура под лентой, автообновление мимо панели,
 * прогресс агента и ход субагента справа. Вынесено из `ChatPage` целиком и в
 * том же порядке хуков — поведение то же.
 */
export function useChatFeed({ activeChatId, consumer, run, stream, isRunning }: ChatFeedInput) {
  // Размер окна ленты: «Загрузить ещё» растит его, возврат в отлистанный
  // разговор возвращает и его окно (подробности — в хуке).
  const messagesLimit = useMessagesLimit(activeChatId);
  const messages = useChatMessages(activeChatId, messagesLimit.limit);
  const messageList = messages.data?.messages ?? [];
  // Пока потоковый пузырь на экране, текущий ход агента рисует он один: из
  // истории такой ход убираем, иначе перечитка ленты посреди прогона
  // показывает те же вызовы дважды — по разу из каждого источника.
  const shownHistory = withoutLiveTurn(messageList, run.startedAt, isStreamShown(stream));
  // Ход через контур без вызовов или с вызовом текстом — назвать под лентой
  // (развилки 3 и 5): иначе «агент ничего не сделал» выглядит поломкой панели.
  const toolHint = useTurnToolHint(consumer, lastTurnFacts(messageList), isRunning);
  // Разговор мог продолжиться мимо панели — из терминала или расширения
  // редактора. Такой ход не даёт потока событий, и лента жила бы снимком на
  // момент открытия: вопрос агента человек увидел бы только после F5. То же
  // с припаркованным прогоном — потока к нему нет, правда в транскрипте.
  useChatAutoRefresh(activeChatId, isRunning, run.stalled === true || run.parked === true);
  // Прогресс агента читается из транскрипта, поэтому нужен настоящий id сессии:
  // у нового разговора он появляется только с первым событием потока.
  const progressChatId = activeChatId ?? run.sessionId;
  const progress = useChatProgress(progressChatId, isRunning);
  // Ход субагента справа — открыт деревом или переходом из карточки группы.
  const agentPane = useAgentPane(progressChatId);
  return {
    messagesLimit,
    messages,
    messageList,
    shownHistory,
    toolHint,
    progressChatId,
    progress,
    agentPane,
  };
}
