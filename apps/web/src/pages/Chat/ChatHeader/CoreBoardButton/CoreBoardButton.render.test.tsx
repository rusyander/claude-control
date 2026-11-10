import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRouter,
} from '@tanstack/react-router';
import type { BoardCard, BoardReply } from '@agentdeck/contracts/core/board';
import { CORE_BOARD_KEY } from '@entities/CoreTask';
import { i18n } from '@shared/config/i18n';
import { CoreBoardButton } from './CoreBoardButton';

/** Кнопка доски в шапке чата: число «ждёт вас» — из ответа доски ядра, а не из вопросов чата. */

const base: Omit<BoardCard, 'id' | 'waiting' | 'questions'> = {
  kind: 'task',
  column: 'work',
  title: 't',
  stop: 'mr',
  takeover: null,
  moves: [],
  createdAt: 1,
};

const reply = (cards: Array<Pick<BoardCard, 'id' | 'waiting' | 'questions'>>): BoardReply => ({
  cards: cards.map((c) => ({ ...base, ...c })),
  entries: [],
  limits: {
    inWork: { used: 0, cap: 2 },
    perDay: { used: 0, cap: null },
    paused: false,
    stopOnQuestion: false,
    defaultStop: 'mr',
  },
});

async function render(data: BoardReply | undefined): Promise<string> {
  await i18n.changeLanguage('ru');
  const client = new QueryClient();
  if (data) client.setQueryData(CORE_BOARD_KEY, data);
  const router = createRouter({
    routeTree: createRootRoute({ component: () => <CoreBoardButton /> }),
    history: createMemoryHistory({ initialEntries: ['/chat'] }),
  });
  await router.load();
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

describe('chat header board button', () => {
  it('shows the core waiting count; non-blocking questions are not counted', async () => {
    const html = await render(
      reply([
        { id: 'a', waiting: true, questions: 0 },
        { id: 'b', waiting: false, questions: 4 },
        { id: 'c', waiting: true, questions: 1 },
      ]),
    );
    expect(html).toContain('data-board-waiting="2"');
    expect(html).toContain('Доска · ждёт вас: 2');
  });

  it('no waiting cards or no board answer — just «Доска», without a count', async () => {
    for (const data of [reply([{ id: 'a', waiting: false, questions: 1 }]), undefined]) {
      const html = await render(data);
      expect(html).not.toContain('data-board-waiting');
      expect(html).toContain('>Доска<');
    }
  });
});
