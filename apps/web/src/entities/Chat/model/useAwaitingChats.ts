import { useEffect, useMemo, useRef } from 'react';
import type { ChatSummary } from '@claude-control/contracts';
import { useChatStatuses } from '@shared/lib/agent-runs';
import { notifyAgent } from '@shared/lib/notify-sound';
import { useChats } from '../api/ChatApi';
import { selectAwaitingChats } from './awaiting';

/** Разговоры, стоящие на вопросе к человеку, — по данным транскрипта. */
export function useAwaitingChats(): ChatSummary[] {
  const { data } = useChats();
  const statuses = useChatStatuses();
  return useMemo(() => selectAwaitingChats(data ?? [], statuses), [data, statuses]);
}

/**
 * Тот же список, но со звуком: сигнал раздаётся ОДИН раз на повод — когда
 * разговор впервые оказался ждущим. Первый снимок только запоминается: панель
 * открыли, а вопрос висит со вчера — звонить об этом значит приучить человека
 * не обращать внимания на звук.
 *
 * Монтируется единственный раз, на уровне приложения: два места вызова = два
 * звонка на один и тот же вопрос.
 */
export function useAwaitingAlarm(): ChatSummary[] {
  const { data } = useChats();
  const awaiting = useAwaitingChats();
  const known = useRef<Set<string> | undefined>(undefined);

  useEffect(() => {
    if (!data) return;

    const ids = new Set(awaiting.map((chat) => chat.id));
    const seeded = known.current;
    known.current = ids;
    if (!seeded) return;

    for (const id of ids) {
      if (seeded.has(id)) continue;
      notifyAgent('waiting');
      return;
    }
  }, [awaiting, data]);

  return awaiting;
}
