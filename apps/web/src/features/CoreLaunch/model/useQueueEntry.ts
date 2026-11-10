import { useRef, useState } from 'react';
import type { BoardStop } from '@agentdeck/contracts/core/board';
import type { EstimateFields } from '@agentdeck/contracts/core/estimate';
import { boardMoveRefusalOf, newUuidv7, useBoardEntries, useCoreBoard } from '@entities/CoreTask';
import { defaultStopOf, entryDraftOf } from './queueEntry';

/**
 * «В очередь» на форме запуска: остановка (умолчание — из пределов доски, пока человек не выбрал
 * свою) и запись на доску. Ответа нет вовсе (обрыв связи) — ключ повтора держится для тех же
 * полей: повтор найдёт уже созданную запись, а не положит вторую. Ядро ответило — ключ сброшен.
 */
export function useQueueEntry() {
  const board = useCoreBoard();
  const entries = useBoardEntries();
  const [chosen, setChosen] = useState<BoardStop | null>(null);
  const [queued, setQueued] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);
  const attempt = useRef<{ key: string; cmdId: string } | null>(null);
  const stop = chosen ?? defaultStopOf(board.data?.limits);

  const queue = async (fields: EstimateFields) => {
    const entry = entryDraftOf(fields, stop);
    const key = JSON.stringify(entry);
    if (attempt.current?.key !== key) attempt.current = { key, cmdId: newUuidv7() };
    setRefusal(null);
    setQueued(null);
    try {
      const reply = await entries.mutateAsync({
        to: 'queue',
        entries: [entry],
        cmdId: attempt.current.cmdId,
      });
      attempt.current = null;
      // Повтор того же ключа ядро отвечает той же доской без новых id — запись всё равно лежит.
      setQueued(reply.created[0] ?? '');
    } catch (error) {
      const why = boardMoveRefusalOf(error);
      if (why.status !== undefined) attempt.current = null;
      setRefusal(why.reason);
    }
  };

  return {
    stop,
    setStop: setChosen,
    queue,
    pending: entries.isPending,
    /** Ответа не было: кнопка говорит «повторить» — тем же ключом. */
    retrying: attempt.current !== null && refusal !== null,
    queued,
    refusal,
  };
}

export type QueueEntryState = ReturnType<typeof useQueueEntry>;
