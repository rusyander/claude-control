import { useMutation } from '@tanstack/react-query';
import { runAssistant } from '../lib/runAssistant';

/** Отправить историю сообщений активному провайдеру и получить ответ (basic). */
export function useRunAssistant() {
  return useMutation({ mutationFn: runAssistant });
}
