import { useChatWatchSignals, watchSignalsOf } from '@entities/ChatGroupSettings';
import { GroupSignals } from '../GroupSignals/GroupSignals';
import type { ChatWatchIslandProps } from './ChatWatchIsland.types';
import styles from './ChatWatchIsland.module.scss';

/**
 * Остров «Сторож чата» над лентой одиночного чата: те же строки сигналов, что в
 * карточке группы, но без «Открыть чат» — человек уже здесь. Сигнал ищется по
 * обоим ключам разговора (сторож пишет под тем, что знал при старте прогона).
 * Сервер отдаёт только активные — кончилось условие, остров пропадает сам.
 */
export function ChatWatchIsland({ chatId, sessionId }: ChatWatchIslandProps) {
  const query = useChatWatchSignals();
  const signals = watchSignalsOf(query.data, [chatId, sessionId]);
  if (!chatId || signals.length === 0) return null;
  return (
    <div className={styles.wrap} data-chat-watch={signals.length}>
      <GroupSignals signals={signals} scope="chat" />
    </div>
  );
}
