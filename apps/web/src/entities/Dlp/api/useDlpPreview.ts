import { useMutation } from '@tanstack/react-query';
import { preview } from '../lib/preview';

/**
 * Проверка правил на пробном тексте — без сети и без записи. Правила можно
 * прислать черновиком: смотреть результат ДО сохранения важнее, чем после.
 */
export function useDlpPreview() {
  return useMutation({ meta: { silentError: true }, mutationFn: preview });
}
