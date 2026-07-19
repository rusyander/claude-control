import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';
import { I18nextProvider } from 'react-i18next';
import { i18n } from '@shared/config/i18n';
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
          </FileWatchProvider>
        </ThemeProvider>
      </I18nextProvider>
    </QueryClientProvider>
  </StrictMode>,
);
