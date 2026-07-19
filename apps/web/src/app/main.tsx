import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { MutationCache, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';
import { I18nextProvider } from 'react-i18next';
import { i18n } from '@shared/config/i18n';
import { toast } from '@shared/lib/toast';
import { toErrorMessage } from '@shared/api/client';
import { Toaster } from '@shared/ui/toast';
import '@shared/api/mutation-meta';
import { ThemeProvider } from './providers/ThemeProvider';
import { FileWatchProvider } from './providers/FileWatchProvider';
import { router } from './router/router';
import '@shared/styles/global.scss';

const queryClient = new QueryClient({
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
    onSuccess: (_data, _variables, _context, mutation) => {
      const key = mutation.meta?.successMessage;
      if (key) toast.success(i18n.t(key));
    },
    onError: (error, _variables, _context, mutation) => {
      if (mutation.meta?.silentError) return;
      const key = mutation.meta?.errorMessage;
      toast.error(key ? i18n.t(key) : toErrorMessage(error));
    },
  }),
});

const container = document.getElementById('root');
if (!container) throw new Error('Не найден корневой элемент #root');

createRoot(container).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <I18nextProvider i18n={i18n}>
        <ThemeProvider>
          <FileWatchProvider>
            <RouterProvider router={router} />
            <Toaster />
          </FileWatchProvider>
        </ThemeProvider>
      </I18nextProvider>
    </QueryClientProvider>
  </StrictMode>,
);
