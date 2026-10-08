import type { PlatformAgentAnswer } from '@agentdeck/contracts';
import { apiClient, LONG_TIMEOUTS } from '@shared/api/client';
import { path } from '../lib/path';
import { useQueryClient, useMutation } from '@tanstack/react-query';
import { queryKeys } from '@shared/api/query-keys';

/**
 * Вопрос агенту контура. Ответ приходит ЛЮБЫМ исходом со статусом 200:
 * «агентов нет в лицензии компании» — это состояние карточки, а не сбой сети.
 */
export async function askAgent(input: {
  id: string;
  agent: string;
  message: string;
  session?: string;
}): Promise<PlatformAgentAnswer> {
  const { data } = await apiClient.post<PlatformAgentAnswer>(
    path(input.id, '/agents/ask'),
    {
      agent: input.agent,
      message: input.message,
      ...(input.session ? { session: input.session } : {}),
    },
    // Свой таймаут обязателен: общие 60 с короче бюджета сервера (125 с), и
    // ответ агента длиннее минуты браузер обрывал бы ложной ошибкой, пока
    // контур доводит прогон и списывает его с ключа.
    { timeout: LONG_TIMEOUTS.agentAsk },
  );
  return data;
}

/**
 * Спросить агента контура.
 *
 * Мутация, а не запрос: вызов агента тратит деньги ключа и пишется в его
 * историю — повторить его «на всякий случай» при перерисовке нельзя. Ответ
 * всегда 200 с исходом внутри, поэтому `onError` здесь ловит только беду с
 * самой панелью.
 */
export function useAskAgent() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: askAgent,
    // Сессию перечитываем ПОСЛЕ хода: она заводится на контуре только вместе с
    // первым удачным ходом, и прочитанная до него «пустая» переписка иначе
    // осталась бы на экране навсегда — рядом с настоящим ответом агента.
    onSuccess: (_answer, variables) => {
      if (!variables.session) return;
      void queryClient.invalidateQueries({
        queryKey: queryKeys.platformAgentSession(variables.id, variables.session),
      });
    },
  });
}
