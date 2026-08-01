import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';
import { I18nextProvider } from 'react-i18next';
import { i18n } from '@shared/config/i18n';
import { Toaster } from '@shared/ui/toast';
import '@shared/api/mutation-meta';
import { queryClient } from './queryClient';
import { ThemeProvider } from './providers/ThemeProvider';
import { FileWatchProvider } from './providers/FileWatchProvider';
import { router } from './router/router';
import '@shared/styles/global.scss';

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
