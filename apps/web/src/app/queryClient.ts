import { MutationCache, QueryClient } from '@tanstack/react-query';
import { i18n } from '@shared/config/i18n';
import { toast } from '@shared/lib/toast';
import { toErrorMessage } from '@shared/api/client';

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Данные приходят с локального диска, а об изменениях сообщает
      // поток событий — периодический перезапрос не нужен.
      refetchOnWindowFocus: false,
      staleTime: 30_000,
      retry: 1,
    },
  },
  // Единая точка уведомлений о результате мутаций. Ошибка любого запроса на
  // запись показывается тостом автоматически — ни одну не пропустим. Тост об
  // успехе — только если мутация задала meta.successMessage (осмысленные
  // действия: создание, удаление и т.п.), чтобы фоновые запросы не шумели.
  mutationCache: new MutationCache({
    onSuccess: (data, _variables, _context, mutation) => {
      const key = mutation.meta?.successMessage;
      if (!key) return;
      // Если сервер вернул путь резервной копии — называем её: раньше о копии
      // можно было узнать только из справки.
      const backupPath = (data as { backupPath?: unknown } | null)?.backupPath;
      if (typeof backupPath === 'string' && backupPath) {
        const name = backupPath.split(/[\\/]/).pop();
        toast.success(`${i18n.t(key)} · ${i18n.t('toasts.backupSaved', { name })}`);
      } else {
        toast.success(i18n.t(key));
      }
    },
    onError: (error, _variables, _context, mutation) => {
      if (mutation.meta?.silentError) return;
      const key = mutation.meta?.errorMessage;
      toast.error(key ? i18n.t(key) : toErrorMessage(error));
    },
  }),
});
