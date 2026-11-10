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
import type { BoardCard, BoardReply } from '@agentdeck/contracts/core/board';
import { CORE_BOARD_KEY } from '@entities/CoreTask';
import { i18n } from '@shared/config/i18n';
import { CoreBoard } from './CoreBoard';

/**
 * Доска на разметке: колонки и их счёт — из ответа ядра, чип «Ждёт вас» — флаг карточек, а не
 * пересчёт вопросов; режим полос — по группе ядра.
 */

function card(id: string, extra: Partial<BoardCard> = {}): BoardCard {
  return {
    kind: 'task',
    id,
    taskId: id,
    column: 'work',
    title: `Task ${id}`,
    stop: 'mr',
    waiting: false,
    questions: 0,
    takeover: null,
    moves: [],
    createdAt: 1,
    ...extra,
  };
}

const reply: BoardReply = {
  cards: [
    card('e1', { kind: 'entry', entryId: 'e1', taskId: undefined, column: 'queue', rank: 1 }),
    card('w1', { column: 'work', groupId: 'grp-alpha-123456' }),
    card('w2', { column: 'work', groupId: 'grp-alpha-123456', questions: 2 }),
    card('a1', { column: 'waiting', waiting: true }),
    card('c1', { column: 'closed' }),
  ],
  entries: [],
  limits: {
    inWork: { used: 2, cap: 2 },
    perDay: { used: 3, cap: null },
    paused: false,
    stopOnQuestion: false,
    defaultStop: 'mr',
  },
};

async function render(node: ReactNode, data: BoardReply = reply): Promise<string> {
  await i18n.changeLanguage('ru');
  const client = new QueryClient();
  client.setQueryData(CORE_BOARD_KEY, data);
  const router = createRouter({
    routeTree: createRootRoute({ component: () => node }),
    history: createMemoryHistory({ initialEntries: ['/core'] }),
  });
  await router.load();
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

const countOf = (html: string, column: string) =>
  html.match(new RegExp(`data-board-column="${column}" data-board-column-count="(\\d+)"`))?.[1];

describe('core board render', () => {
  it('column counts equal the core reply; closed cards stay out of the stage columns', async () => {
    const html = await render(<CoreBoard search={{}} />);
    expect(countOf(html, 'queue')).toBe('1');
    expect(countOf(html, 'work')).toBe('2');
    expect(countOf(html, 'waiting')).toBe('1');
    expect(countOf(html, 'review')).toBe('0');
    expect(html).not.toContain('data-board-card="c1"');
    expect(html).toContain('data-board-closed="folded"');
  });

  it('the waiting chip counts flagged cards only; a non-blocking question is a badge', async () => {
    const html = await render(<CoreBoard search={{}} />);
    expect(html).toContain('data-board-waiting="1"');
    expect(html).toContain('Ждёт вас · 1');
    expect(html).toContain('data-board-card-questions="2"');
  });

  it('lane mode draws one lane per core group with its cards', async () => {
    const html = await render(<CoreBoard search={{ view: 'board', lane: 'group' }} />);
    expect(html).toContain('data-board-lane="group"');
    expect(html).toContain('data-board-lane-group="grp-alpha-123456" data-board-lane-count="2"');
    // Якорь агента панели: `/groups` с фокусом-группой подсвечивает эту полосу.
    expect(html).toContain('data-agent-anchor="grp-alpha-123456"');
    expect(html).not.toContain('data-board-card="e1"');
  });

  it('a group filter whose open cards are gone keeps its chip, pressed, so it can be cleared', async () => {
    const html = await render(<CoreBoard search={{ view: 'board', group: 'grp-done-654321' }} />);
    expect(html).toMatch(/aria-pressed="true"[^>]*data-board-group-chip="grp-done-654321"/);
    expect(html).toContain('data-board-group-chip="grp-alpha-123456"');
  });

  it('config issues from the core: the board says the limits are defaults and names the reason', async () => {
    expect(await render(<CoreBoard search={{}} />)).not.toContain('data-board-config-issues');
    const bad = await render(<CoreBoard search={{}} />, {
      ...reply,
      configIssues: [{ section: 'board', reason: 'inWork: Invalid input' }],
    });
    expect(bad).toContain('data-board-config-issues');
    expect(bad).toContain('действуют умолчания: inWork: Invalid input');
    const unreadable = await render(<CoreBoard search={{}} />, {
      ...reply,
      configIssues: [{ section: '*', reason: 'config.json not JSON' }],
    });
    expect(unreadable).toContain('Настройка ядра не читается — очередь стоит');
  });
});
