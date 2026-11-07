import { useQuery } from '@tanstack/react-query';
import { apiClient } from '@shared/api/client';
import { KEY } from './ChatCliApi.constants';

/**
 * CLI разговора чата (W3-17a): новый — активный провайдер, начатый — тот, которым начат (книга
 * чата на сервере, `GET /api/chat/core-cli/:id`; незнакомый разговор — Claude). По нему шапка
 * выбирает каталог моделей: модель Claude другому CLI не предлагается.
 *
 * `turnEnded` в ключе — перечитать после хода: книга пишет CLI нового разговора на его старте.
 * `undefined` — ещё не известно (список провайдеров или ответ сервера в пути).
 */
export function useConversationCli(
  conversationId: string | undefined,
  activeCli: string | undefined,
  turnEnded: boolean,
): string | undefined {
  const query = useQuery({
    queryKey: [...KEY, 'conversation', conversationId ?? '', turnEnded],
    queryFn: async () => {
      const { data } = await apiClient.get<{ cli: string }>(
        `/chat/core-cli/${encodeURIComponent(conversationId ?? '')}`,
      );
      return data.cli;
    },
    enabled: Boolean(conversationId),
    staleTime: 60_000,
  });
  return conversationId ? query.data : activeCli;
}
