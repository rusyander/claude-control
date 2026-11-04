import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRouter,
} from '@tanstack/react-router';
import type { TasksReply } from '@agentdeck/contracts/core/panel-api';
import { queryKeys } from '@shared/api/query-keys';
import { i18n } from '@shared/config/i18n';
import { CoreTasksPage } from './CoreTasksPage';

/**
 * Список «Задачи ядра»: состояние задачи на плашке — словами языка панели, а не сырым
 * `awaiting-launch` из журнала ядра (разбор кадров справки, этап 10).
 */

const reply: TasksReply = {
  tasks: [
    {
      taskId: 't-1',
      live: true,
      seq: 3,
      state: 'awaiting-launch',
      ended: null,
      title: 'Log triage',
      attention: null,
    },
  ],
};

async function render(lang: 'ru' | 'en'): Promise<string> {
  await i18n.changeLanguage(lang);
  const client = new QueryClient();
  client.setQueryData(queryKeys.core.tasks, reply);
  // Ссылка «Открыть ленту» — роутерная: страница рисуется под настоящим роутером.
  const router = createRouter({
    routeTree: createRootRoute({ component: () => <CoreTasksPage /> }),
    history: createMemoryHistory({ initialEntries: ['/core'] }),
  });
  await router.load();
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

describe('core task list', () => {
  it('the task state badge is in words of the panel language, never the raw state', async () => {
    const ru = await render('ru');
    expect(ru).toContain('Log triage');
    expect(ru).toContain('ждёт запуска');
    expect(ru).not.toContain('awaiting-launch');
    const en = await render('en');
    expect(en).toContain('awaiting launch');
    expect(en).not.toContain('awaiting-launch');
  });
});
