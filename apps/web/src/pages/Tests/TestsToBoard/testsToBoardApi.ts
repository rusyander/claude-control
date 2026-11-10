import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { BoardEntriesReply } from '@agentdeck/contracts/core/board';
import {
  CORE_BOARD_KEY,
  boardEntriesBody,
  corePost,
  fetchNonce,
  pageLoadId,
  type BoardEntriesDraft,
} from '@entities/CoreTask';

/**
 * Запись «Входящих» из красного кейса — тот же `POST /v1/board/entries`, что у «В очередь» формы
 * запуска, но отказ кнопка показывает сама, рядом с собой: общий тост его бы удвоил.
 */
export function useTestsToBoard() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (draft: BoardEntriesDraft): Promise<BoardEntriesReply> => {
      const page = pageLoadId();
      const nonce = await fetchNonce(page);
      return corePost<BoardEntriesReply>(
        '/board/entries',
        boardEntriesBody(draft.to, draft.entries, { nonce, page }, draft.cmdId),
      );
    },
    meta: { silentError: true },
    onSettled: () => queryClient.invalidateQueries({ queryKey: CORE_BOARD_KEY }),
  });
}
