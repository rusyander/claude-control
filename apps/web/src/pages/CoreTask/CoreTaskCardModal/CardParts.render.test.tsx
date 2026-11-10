import { describe, expect, it } from 'vitest';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRouter,
} from '@tanstack/react-router';
import type { BoardCard } from '@agentdeck/contracts/core/board';
import { useBoardMove } from '@entities/CoreTask';
import { i18n } from '@shared/config/i18n';
import { CardFactsList } from './CardFactsList';
import { CardMoves } from './CardMoves';

/**
 * Окно карточки по частям (без портала окна — статичная разметка его не рисует): факта нет —
 * «нет данных», а не 0; кнопки ходов — ровно разрешённые ядром.
 */

const entry: BoardCard = {
  kind: 'entry',
  id: 'e1',
  entryId: 'e1',
  column: 'inbox',
  title: 'Queued work',
  state: 'inbox',
  stop: 'plan',
  preset: 'feature',
  source: { kind: 'manual', title: 'Queued work' },
  waiting: false,
  questions: 0,
  takeover: null,
  moves: ['queue', 'rejected'],
  createdAt: 1_700_000_000_000,
};

async function render(node: ReactNode): Promise<string> {
  await i18n.changeLanguage('ru');
  const router = createRouter({
    routeTree: createRootRoute({ component: () => node }),
    history: createMemoryHistory({ initialEntries: ['/core'] }),
  });
  await router.load();
  return renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

/** Ход живёт на доске; в тесте частей — свой, как его даёт доска. */
function Moves(props: { card: BoardCard; column: readonly BoardCard[]; stale?: boolean }) {
  return <CardMoves {...props} move={useBoardMove()} />;
}

const fact = (html: string, name: string) =>
  html.match(new RegExp(`data-card-fact="${name}"[^>]*>(.*?)</dd>`))?.[1] ?? '';

describe('core card modal parts', () => {
  it('an entry without a task view shows «нет данных» for spend, agents and progress, never 0', async () => {
    const html = await render(<CardFactsList card={entry} view={undefined} />);
    for (const name of ['spend', 'agents', 'progress', 'estimate', 'mr']) {
      expect(fact(html, name)).toContain('нет данных');
      expect(fact(html, name)).not.toMatch(/\b0\b/);
    }
    expect(fact(html, 'stage')).toContain('Входящие');
    expect(fact(html, 'stop')).toContain('до плана');
    // Пресет — подписью окна выбора «Сценарий», не голым id ядра.
    expect(fact(html, 'scenario')).toContain('Новая возможность');
    expect(fact(html, 'scenario')).not.toContain('feature');
  });

  it('only the moves the core allowed render as buttons', async () => {
    const html = await render(<Moves card={entry} column={[entry]} />);
    expect(html).toContain('data-card-move="queue"');
    expect(html).toContain('data-card-move="rejected"');
    expect(html).not.toContain('data-card-move="work"');
    expect(html).not.toContain('data-card-move="inbox"');
    expect(html).not.toContain('data-card-move="up"');
  });

  it('a card with no allowed moves says the core moves its stage', async () => {
    const html = await render(<Moves card={{ ...entry, moves: [] }} column={[entry]} />);
    expect(html).toContain('data-card-moves-none');
    expect(html).not.toContain('data-card-move=');
  });

  it('a window held on a stale snapshot draws no move buttons and no «no moves» line', async () => {
    const html = await render(<Moves card={entry} column={[entry]} stale />);
    expect(html).not.toContain('data-card-move=');
    expect(html).not.toContain('data-card-moves-none');
  });
});
