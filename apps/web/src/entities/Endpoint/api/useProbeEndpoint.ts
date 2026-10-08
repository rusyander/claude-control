import { useMutation } from '@tanstack/react-query';
import { probe } from '../lib/probe';

/**
 * Проверка связи — отдельной кнопкой: она ходит по сети к чужому адресу. Ответ
 * несёт список моделей, из которого пользователь выбирает имя модели.
 */
export function useProbeEndpoint() {
  return useMutation({ meta: { silentError: true }, mutationFn: probe });
}
