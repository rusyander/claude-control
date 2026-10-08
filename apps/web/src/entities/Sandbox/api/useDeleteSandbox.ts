import { useTranslation } from 'react-i18next';
import { useMutation } from '@tanstack/react-query';
import { apiClient } from '@shared/api/client';
import { toast } from '@shared/lib/toast';
import { sandboxDeleteFailedText } from '../model/sandboxDeleteFailedText';

/**
 * Удаление песочницы. Уходит из размонтирования модалки, то есть с экрана, до
 * которого ответ уже не вернётся, — поэтому отказ показывается тостом.
 *
 * `silentError` выключает общий тост из MutationCache: он показал бы сырое
 * сообщение сервера без объяснения, чем это грозит. Здесь текст свой, с рамкой
 * и на языке интерфейса, а причина сервера (в ней путь к папке) внутри.
 */
export function useDeleteSandbox() {
  const { t } = useTranslation();

  return useMutation({
    mutationFn: async (id: string) => {
      await apiClient.delete(`/sandbox/${encodeURIComponent(id)}`);
    },
    meta: { silentError: true },
    onError: (error) => toast.error(sandboxDeleteFailedText(error, t)),
  });
}
