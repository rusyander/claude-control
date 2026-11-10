import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRouter,
} from '@tanstack/react-router';
import type { BoardCard } from '@agentdeck/contracts/core/board';
import { i18n } from '@shared/config/i18n';
import { CoreTakeoverAction } from './CoreTakeoverAction';

/**
 * Окно карточки задачи: блок ручного вмешательства рисует ровно действия этого состояния, а у
 * открытого перехвата — копию и ссылку на чат перехвата (`/core/chat?id=` ведёт в его разговор).
 */

const TASK = '01900000-0000-7000-8000-000000000001';
const CHAT = '01900000-0000-7000-8000-000000000002';

const card = (extra: Partial<BoardCard>): BoardCard => ({
  kind: 'task',
  id: TASK,
  taskId: TASK,
  column: 'work',
  title: 't',
  state: 'running',
  stop: 'mr',
  waiting: false,
  questions: 0,
  takeover: null,
  moves: [],
  createdAt: 1,
  ...extra,
});

async function render(c: BoardCard): Promise<string> {
  await i18n.changeLanguage('ru');
  const router = createRouter({
    routeTree: createRootRoute({
      component: () => <CoreTakeoverAction taskId={TASK} card={c} />,
    }),
    history: createMemoryHistory({ initialEntries: ['/core'] }),
  });
  await router.load();
  return renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

describe('CoreTakeoverAction', () => {
  it('running task: take over, rework (disabled until text) and the stop select; no hand-back', async () => {
    const html = await render(card({}));
    expect(html).toContain('data-core-takeover="closed"');
    expect(html).toContain('Взять вручную');
    expect(html).toContain('data-takeover-open');
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*data-takeover-rework/);
    expect(html).toContain('До MR');
    expect(html).not.toContain('data-takeover-handback');
  });

  it('open takeover: copy path, chat link to the takeover chat, hand-back; take over again is gone', async () => {
    const html = await render(
      card({
        state: 'paused',
        takeover: { unitId: 'u', copy: 'C:/copies/unit-1', chatTaskId: CHAT },
      }),
    );
    expect(html).toContain('data-core-takeover="open"');
    expect(html).toContain('C:/copies/unit-1');
    expect(html).toContain(`href="/core/chat?id=${CHAT}"`);
    expect(html).toContain('Вернуть ядру');
    expect(html).not.toContain('data-takeover-open');
    expect(html).not.toContain('data-takeover-rework');
  });

  it('merged MR: nothing to do — renders nothing', async () => {
    const html = await render(
      card({
        state: 'done',
        mr: { url: 'https://forge.example.com/mr/4', iid: 4, state: 'merged' },
      }),
    );
    expect(html).not.toContain('data-core-takeover');
  });
});
