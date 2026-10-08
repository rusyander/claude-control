import { useQuery } from '@tanstack/react-query';
import { chatKeys } from './ChatApi.constants';
import { apiClient } from '@shared/api/client';
import type { ChatProgress } from '@agentdeck/contracts';

/**
 * Прогресс агента: его собственные чекпоинты и дерево субагентов. Источник —
 * транскрипт, поэтому данные есть и у вчерашнего разговора, а не только у
 * открытой вкладки. Пока агент работает, перечитываем раз в несколько секунд:
 * CLI дописывает транскрипт по ходу дела, и план обновляется почти сразу.
 *
 * Между ходами — реже и только пока в фоне что-то идёт: процесс разговора
 * живёт дальше, и фон может как кончиться, так и оборваться вместе с ним.
 */
export function useChatProgress(
  chatId: string | undefined,
  isRunning: boolean,
  /**
   * Как часто перечитывать идущий прогон. Строке группы в хабе родителя
   * хватает раза в 15 с: шаг меняется за минуты, а шесть групп по 4 с — это
   * полтора синхронных разбора транскрипта в секунду на сервере (ревью 29.09).
   */
  runningPollMs = 4000,
) {
  return useQuery({
    queryKey: chatKeys.progress(chatId ?? ''),
    queryFn: async () => {
      const { data } = await apiClient.get<ChatProgress>(`/chat/${chatId}/progress`);
      return data;
    },
    enabled: Boolean(chatId),
    refetchInterval: (query) => {
      if (isRunning) return runningPollMs;
      const data = query.state.data;
      const backgroundAlive =
        data?.processAlive === true &&
        (data.shells ?? []).some((shell) => shell.status === 'running');
      return backgroundAlive ? 15_000 : false;
    },
  });
}
